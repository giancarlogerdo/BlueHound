const {app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { handleSharpHoundResultsUpload } = require('./collectors/BloodHoundUploader.tsx');
const logMessages = [];

let mainWindow;
let shellEnvironments;
let logLevel = {
    0: "verbose",
    1: "info",
    2: "warning",
    3: "error"
}

function createWindow () {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        //titleBarStyle: "hidden",
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
    })

    // mainWindow.webContents.openDevTools();
    mainWindow.removeMenu();
    mainWindow.maximize();
    mainWindow.loadFile('./dist/index.html')

    if (process.platform === 'darwin') {
        const template = [
            {
                label: app.getName(),
                submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }]
            }
            ]
        Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    }


    import('shell-env').then(envPath => { shellEnvironments = envPath.shellEnvSync(); })

    // open links in a browser instead of in the electron window
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        let fileName = sourceId.replace(/^.*[\\\/]/, '');
        if (os.platform() === 'win32') fileName = sourceId.split('\\')[-1];
        logMessages.push([logLevel[level], message, fileName].join(' | '));
    });
}

app.on('ready', createWindow);

const runningProcesses = {};

ipcMain.handle("open-dev-tools", async (event) => {
    await mainWindow.webContents.openDevTools();
});

ipcMain.handle("get-console-messages", async (event) => {
    event.sender.send('console-messages', logMessages.join('\n'));
});

ipcMain.handle("browse-file", async (event, toolId) => {
    const file = await dialog.showOpenDialog({properties: (os.platform() === 'linux' || os.platform() === 'win32') ? ['openFile'] : ['openFile', 'openDirectory']});
    if (file && file.filePaths[0]) {
        event.sender.send('selected-file', toolId, file.filePaths[0]);
    }
});

ipcMain.handle("browse-folder", async (event, toolId) => {
    const folder = await dialog.showOpenDialog({properties: ['openDirectory']});
    if (folder && folder.filePaths[0]) {
        event.sender.send('selected-file', toolId, folder.filePaths[0]);
    }
});

function getPythonBinaryName() {
    const isPyAvailable = require('hasbin').sync('python')
    const isPy3Available = require('hasbin').sync('python3')
    return isPyAvailable ? "python" : (isPy3Available ? "python3" : null)
}

const runTool = async (event, toolId, toolPath, tookArgs, workingDirectory) => {
    const result = spawn(toolPath, tookArgs, { env: shellEnvironments, cwd: workingDirectory })
    runningProcesses[toolId] = result;

    result.stdout.on('data', (data) => {
        event.sender.send("tool-data", toolId, data.toString())
    });

    result.stderr.on('data', (data) => {
        event.sender.send("tool-data-error", toolId, data.toString())
    });

    result.on('error', function (err) { // needed for catching ENOENT
        event.sender.send("tool-data-error", toolId, err)
    });

    result.on('close', (code) => {
        event.sender.send("tool-data-done", toolId, code, path.dirname(toolPath))
        delete runningProcesses[toolId];
    });
}

ipcMain.handle("run-tool", async (event, toolId, toolPath, toolArgs) => {
    import('shell-env').then(envPath => { shellEnvironments = envPath.shellEnvSync(); })
    const workingDirectory = path.dirname(toolPath);
    await runTool(event, toolId, toolPath, toolArgs, workingDirectory);
})

const runToolsInSerial = async (event, toolsData) => {
    const tool = toolsData[0]
    let toolPath = tool["path"]
    let toolArgs = tool["args"]
    let toolType = tool["toolType"]
    const workingDirectory = path.dirname(toolPath);

    if (toolType == 1) {
        [toolArgs, toolPath] = paramsForPythonTool(event, toolArgs, toolPath);
        if ((!toolArgs) || (!toolPath)) {
            if (toolsData.length > 1) {
                runToolsInSerial(event, toolsData.slice(1));
                return
            } else {
                return
            }
        }
    }

    const result = spawn(toolPath, toolArgs, { env: shellEnvironments, cwd: workingDirectory })
    runningProcesses[tool.toolId] = result;

    result.stdout.on('data', (data) => {
        event.sender.send("tool-data", tool.toolId, data.toString())
    });

    result.stderr.on('data', (data) => {
        event.sender.send("tool-data-error", tool.toolId, data.toString())
    });

    result.on('error', function (err) { // needed for catching ENOENT
        event.sender.send("tool-data-error", tool.toolId, err)
    });

    result.on('close', (code) => {
        event.sender.send("tool-data-done", tool.toolId, code, path.dirname(toolPath))
        delete runningProcesses[tool.toolId];
        if (toolsData.length > 1) { runToolsInSerial(event, toolsData.slice(1)) };
    });
}

ipcMain.handle("run-tools-serial", async (event, toolsData) => {
    import('shell-env').then(envPath => { shellEnvironments = envPath.shellEnvSync(); })
    await runToolsInSerial(event, toolsData);
})

function paramsForPythonTool(event, toolArgs, toolPath) {
    const pythonBinaryName = getPythonBinaryName()

    if (!pythonBinaryName) {
        event.sender.send("data-collection-error", "Cannot locate Python binary")
        event.sender.send("vulnerability-report-close", -1)
        return [null, null]
    }

    event.sender.send("data-collection-error", toolArgs)
    toolArgs.unshift(toolPath);
    toolPath = pythonBinaryName;
    return [toolArgs, toolPath];
}

ipcMain.handle("run-python", async (event, toolId, toolPath, toolArgs) => {
    import('shell-env').then(envPath => { shellEnvironments = envPath.shellEnvSync(); })
    const [pythonArgs, pythonPath] = paramsForPythonTool(event, toolArgs, toolPath);
    const workingDirectory = path.dirname(toolPath)
    if (pythonArgs && pythonPath) {
        await runTool(event, toolId, pythonPath, pythonArgs, workingDirectory);
    }
})

ipcMain.handle("kill-process", async (event, toolId) => {
    runningProcesses[toolId].kill('SIGKILL');
    delete runningProcesses[toolId];
    event.sender.send("tool-killed", toolId);
})

ipcMain.handle("upload-sharphound-results", async (event, toolId, resultsPath, connectionProperties, clearResults) => {
    await handleSharpHoundResultsUpload(event, toolId, resultsPath, connectionProperties, clearResults);
})
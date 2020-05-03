import { app, BrowserWindow, screen } from 'electron';
import * as path from 'path';
import * as url from 'url';
const fileService = require('./lib/services/files')
const idleService = require('./lib/services/idle')
require('./lib/services/browser-events')
const config = require('./lib/config')
const settings = require('./lib/services/settings')
const server = require('./lib/services/server')

let win: BrowserWindow = null;
const args = process.argv.slice(1),
    serve = args.some(val => val === '--serve');

function createWindow(): BrowserWindow {

  const electronScreen = screen;
  const size = electronScreen.getPrimaryDisplay().workAreaSize;

  // Create the browser window.
  win = new BrowserWindow({
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    webPreferences: {
      nodeIntegration: true
    },
  });

  if (serve) {
    require('electron-reload')(__dirname, {
      electron: require(`${__dirname}/node_modules/electron`)
    });
    win.loadURL('http://localhost:4200');
  } else {
    win.loadURL(url.format({
      pathname: path.join(__dirname, 'dist/index.html'),
      protocol: 'file:',
      slashes: true
    }));
  }

  if (serve) {
    win.webContents.openDevTools();
  }

  // Emitted when the window is closed.
  win.on('closed', () => {
    // Dereference the window object, usually you would store window
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    win = null;
  });

  return win;
}

/**
 * Scans for file changes periodically
 */
function scanPeriodically() {
  setTimeout(() => {
    fileService.scan()
  }, settings.get('rescanDelayInMinutes') * 60 * 1000)
}

function initializeSettings() {
  settings.set(config.defaults)
}

try {

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.on('ready', createWindow);

  // Quit when all windows are closed.
  app.on('window-all-closed', () => {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
      createWindow();
    }
  });

  app.on('ready', () => {
    initializeSettings()
    idleService.startTimer(win)

    let pictureDirectory = settings.get('pictureDirectory')

    if (pictureDirectory) {
      fileService.scan()
      server.startStaticFileServer(pictureDirectory, config.defaults.expressJsPort)
      scanPeriodically()
    }
  })
} catch (e) {
  // Catch Error
  // throw e;
}

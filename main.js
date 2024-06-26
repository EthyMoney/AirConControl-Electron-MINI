const { app, BrowserWindow, screen } = require('electron');
const path = require('path');

// Function to create the main window
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const mainWindow = new BrowserWindow({
    width: width,
    height: height,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: path.join(__dirname, 'snow.ico'),
    fullscreen: true, // Optional: Open the window in fullscreen mode
    frame: false // Optional: Remove window frame if desired (needs to be false to hide mouse cursor)
  });

  // Hide the menu bar
  mainWindow.setMenu(null);

  // Load the index.html file
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open the DevTools (optional)
  //mainWindow.webContents.openDevTools();

  // Handle window close event
  mainWindow.on('closed', function () {
    app.quit();
  });
}

// App ready event
app.whenReady().then(() => {
  createWindow();

  // Additional setup code (if any)

  // macOS specific setup
  if (process.platform === 'darwin') {
    app.dock.hide(); // Hide the app icon in the dock
  }
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Activate the app (only on macOS)
app.on('activate', function () {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

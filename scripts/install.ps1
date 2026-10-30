# Puts the pet where Windows can find it: copies the release build to %LOCALAPPDATA%\Programs\Taskbar Pet, adds
# "Taskbar Pet" to the Start menu (search for it, or pin it) and to Startup (so it starts when you sign in), then
# starts it. Run after each release build:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot '..\src-tauri\target\release\taskbar-pet.exe'
$dir = Join-Path $env:LOCALAPPDATA 'Programs\Taskbar Pet'
New-Item -ItemType Directory -Force $dir | Out-Null
Get-Process taskbar-pet -ErrorAction SilentlyContinue | Stop-Process # a running copy can't be replaced
Start-Sleep -Milliseconds 500
Copy-Item $exe (Join-Path $dir 'taskbar-pet.exe') -Force
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Startup')) {
  $link = $shell.CreateShortcut((Join-Path $folder 'Taskbar Pet.lnk'))
  $link.TargetPath = Join-Path $dir 'taskbar-pet.exe'
  $link.WorkingDirectory = $dir
  $link.Description = 'A cat on your taskbar that keeps your to-dos and notes'
  $link.Save()
}
Start-Process (Join-Path $dir 'taskbar-pet.exe')
"Installed in $dir; it's in the Start menu and starts with Windows"

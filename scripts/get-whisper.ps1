# Downloads Whisper for the notes mic: whisper.cpp's Windows CPU build and its small English model, into the
# pet's data folder. Checks both against the published SHA-256 before keeping them. Run once:
#   powershell -ExecutionPolicy Bypass -File .\scripts\get-whisper.ps1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest many times slower
$dir = Join-Path $env:LOCALAPPDATA 'com.tejal.taskbarpet\whisper'
New-Item -ItemType Directory -Force $dir | Out-Null

$files = @(
  @{ name = 'whisper-bin-x64.zip' # whisper.cpp v1.9.5 (build b5454), from the release's own digest
     url = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip'
     sha256 = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb' },
  @{ name = 'ggml-small.en-q5_1.bin' # from the Hugging Face repo's LFS object id
     url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin'
     sha256 = 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30' },
  # For an NVIDIA GPU: the CUDA build and the much better large-v3-turbo model (used when both are here).
  @{ name = 'whisper-bin-win-cuda-11.8.0-x64.zip'
     url = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-11.8.0-x64.zip'
     sha256 = 'e81c86c542be6e3d7b7245392d4e1c52ab6e5c61dbe38721754bc0ab59d4d027' },
  @{ name = 'ggml-large-v3-turbo-q5_0.bin'
     url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'
     sha256 = '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' }
)
foreach ($f in $files) {
  $path = Join-Path $dir $f.name
  if ((Test-Path $path) -and (Get-FileHash $path -Algorithm SHA256).Hash -eq $f.sha256) { "Have $($f.name)"; continue }
  "Downloading $($f.name)..."
  Invoke-WebRequest -UseBasicParsing $f.url -OutFile "$path.part"
  $got = (Get-FileHash "$path.part" -Algorithm SHA256).Hash
  if ($got -ne $f.sha256) { Remove-Item "$path.part"; throw "$($f.name): checksum $got doesn't match, not kept" }
  Move-Item -Force "$path.part" $path
}

# Each build's program and DLLs go in their own folder (the zips keep them in a Release folder).
foreach ($b in @{ zip = 'whisper-bin-x64.zip'; to = 'bin' }, @{ zip = 'whisper-bin-win-cuda-11.8.0-x64.zip'; to = 'bin-cuda' }) {
  $bin = Join-Path $dir $b.to
  if (Test-Path (Join-Path $bin 'whisper-cli.exe')) { continue } # keeps the cuBLAS DLLs added below
  Expand-Archive (Join-Path $dir $b.zip) (Join-Path $dir 'unzipped') -Force
  $cli = Get-ChildItem (Join-Path $dir 'unzipped') -Recurse -Filter whisper-cli.exe | Select-Object -First 1
  if (-not $cli) { throw "whisper-cli.exe not found in $($b.zip)" }
  Move-Item $cli.DirectoryName $bin
  Remove-Item -Recurse -Force (Join-Path $dir 'unzipped')
}
# The CUDA build needs NVIDIA's cuBLAS, which its zip leaves out (without it, it quietly runs on the CPU). From
# NVIDIA's CUDA 11.8 redistributables (redistrib_11.8.0.json gives the checksum); only the two DLLs are kept.
$cuda = Join-Path $dir 'bin-cuda'
$dlls = 'cublas64_11.dll', 'cublasLt64_11.dll'
if (($dlls | ForEach-Object { Test-Path (Join-Path $cuda $_) }) -contains $false) {
  $zip = Join-Path $dir 'libcublas.zip.part'
  'Downloading NVIDIA cuBLAS 11.11.3.6...'
  Invoke-WebRequest -UseBasicParsing 'https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/libcublas-windows-x86_64-11.11.3.6-archive.zip' -OutFile $zip
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash
  if ($got -ne '67b0934a6359e4ee26fff823c356021589d392c4fd49ca12624f570edc08e2b9') { Remove-Item $zip; throw "cuBLAS: checksum $got doesn't match, not kept" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $z = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    foreach ($e in $z.Entries | Where-Object { $dlls -contains $_.Name }) {
      [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $cuda $e.Name), $true)
    }
  } finally { $z.Dispose() }
  Remove-Item $zip
}
"Whisper is ready in $dir"

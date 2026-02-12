# Dev Notes

## Running the Server Locally

### Launch
```powershell
# Build first
dotnet build AsteroidsWeb/AsteroidsWeb.csproj --configuration Debug

# Launch as a background process (note the PID in output)
$proc = Start-Process -FilePath "dotnet" -ArgumentList "AsteroidsWeb\bin\Debug\net10.0\AsteroidsWeb.dll" -WorkingDirectory "AsteroidsWeb" -PassThru -WindowStyle Hidden; "PID: $($proc.Id)"
```

The server runs at **http://localhost:5000**.

### Stop
```powershell
Stop-Process -Id <PID>
```

### Notes
- Use the DLL directly (`dotnet AsteroidsWeb.dll`), not `dotnet run` — the `dotnet run` wrapper can lose its child process.
- `dotnet watch run --project AsteroidsWeb/AsteroidsWeb.csproj` works for hot reload during development but requires an active terminal session.

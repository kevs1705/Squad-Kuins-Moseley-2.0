' Iniciar_Silencioso.vbs
' Ejecuta el servicio de sincronización en segundo plano de manera 100% invisible (sin ventana de consola)
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

' Obtener el directorio donde reside este script
scriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)

' Ejecutar el comando Node en segundo plano con ventana oculta (0)
WshShell.CurrentDirectory = scriptDir
WshShell.Run "node sincronizar_biometrico.js --daemon", 0, False

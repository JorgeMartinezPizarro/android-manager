; mis-android.iss — el instalador de Mis Android para Windows (Inno Setup 6). No se compila a mano: «npm run instalador»
; (construir.js) descarga antes en vendor\ las copias de Node.js y scrcpy que lleva dentro y le pasa la versión.
; Se instala para el usuario, sin permisos de administrador, en %LOCALAPPDATA%\Programs\Mis Android; sus datos van en
; datos\, dentro de esa carpeta. El desinstalador pregunta si los borra.

#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef VersionInfo
  #define VersionInfo "0.0.0.0"
#endif

[Setup]
AppId={{7D2C4E91-3B5A-4F68-A0C2-91E4B8D6F315}
AppName=Mis Android
AppVersion={#Version}
AppVerName=Mis Android {#Version}
VersionInfoVersion={#VersionInfo}
PrivilegesRequired=lowest
DefaultDirName={autopf}\Mis Android
DisableProgramGroupPage=yes
DisableDirPage=auto
ShowLanguageDialog=no
WizardStyle=modern
SetupIconFile=vendor\mis-android.ico
UninstallDisplayIcon={app}\mis-android.ico
UninstallDisplayName=Mis Android
OutputDir=salida
OutputBaseFilename=MisAndroid-Setup
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "escritorio"; Description: "Crear un acceso directo en el escritorio"
Name: "arranque"; Description: "Arrancar el panel al entrar en Windows (en una ventana minimizada)"; Flags: unchecked

[Files]
Source: "..\panel\*"; DestDir: "{app}\panel"; Flags: recursesubdirs ignoreversion
Source: "..\panel.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\parar-panel.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "vendor\mis-android.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "vendor\*"; DestDir: "{app}\vendor"; Excludes: "mis-android.ico"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Mis Android"; Filename: "{app}\panel.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\mis-android.ico"; Comment: "Los móviles de casa: apps, ajustes y música"
Name: "{autodesktop}\Mis Android"; Filename: "{app}\panel.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\mis-android.ico"; Comment: "Los móviles de casa: apps, ajustes y música"; Tasks: escritorio
Name: "{userstartup}\Mis Android"; Filename: "{app}\panel.cmd"; Parameters: "/fondo"; WorkingDir: "{app}"; IconFilename: "{app}\mis-android.ico"; Flags: runminimized; Tasks: arranque

[Run]
Filename: "{app}\panel.cmd"; Description: "Abrir Mis Android"; Flags: postinstall nowait skipifsilent

[Code]
// Para el panel de esa carpeta, si está en marcha: su Node.js y su adb tienen los ficheros en uso
procedure StopPanel(Dir: String);
var
  Code: Integer;
begin
  if FileExists(Dir + '\parar-panel.ps1') then
    Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + Dir + '\parar-panel.ps1"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

// Al actualizar, antes de copiar encima
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopPanel(ExpandConstant('{app}'));
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if CurUninstallStep = usUninstall then
    StopPanel(ExpandConstant('{app}'));
  if CurUninstallStep = usPostUninstall then begin
    Data := ExpandConstant('{app}\datos');
    if DirExists(Data) and (SuppressibleMsgBox('¿Borro también tus datos de Mis Android? Son los móviles, sus nombres, las apps y las canciones que hay en ' + Data + '.' + #13#10#13#10 + 'Si dices que no, se quedan ahí y los recupera si lo vuelves a instalar.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES) then
      DelTree(Data, True, True, True);
    RemoveDir(ExpandConstant('{app}'));
  end;
end;

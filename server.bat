@echo off
setlocal
cd /d "%~dp0"
title La Box de Yenalia - Serveur local
echo Demarrage du serveur local sur http://localhost:3000
echo.

if not exist ".\server.js" (
    echo Le fichier server.js est introuvable.
    echo.
    pause
    exit /b 1
)

call npm start

echo.
echo Le serveur s'est arrete. Appuie sur une touche pour fermer cette fenetre.
pause >nul
endlocal

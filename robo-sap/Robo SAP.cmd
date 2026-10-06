@echo off
title Robo SAP - Controle de Producao
cd /d "%~dp0"
cscript //nologo //E:jscript "%~dp0robo-sap.js" %*
if errorlevel 1 (
  echo.
  echo O robo parou com erro. A mensagem esta acima e no arquivo robo-sap.log.
  pause
) else (
  timeout /t 8 >nul
)

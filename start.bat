@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js غير مثبت. نزله من https://nodejs.org ثم شغل الملف مرة ثانية. & pause & exit /b 1)
if not exist node_modules (echo تثبيت المكتبات لأول مرة... & call npm install --omit=dev)
if not exist .env (copy .env.example .env >nul & echo افتح ملف .env وحط مفتاح GEMINI_API_KEY ثم شغل الملف مرة ثانية. & notepad .env & exit /b 0)
start "" http://localhost:3939/control
call npm start
pause

#!/usr/bin/env sh
# تشغيل لمّوعة على لينكس/ماك
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js غير مثبت: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --omit=dev
[ -f .env ] || { cp .env.example .env; echo "عبّ GEMINI_API_KEY في ملف .env ثم شغّل مرة ثانية"; exit 0; }
( sleep 2; (xdg-open http://localhost:3939/control || open http://localhost:3939/control) >/dev/null 2>&1 ) &
exec npm start

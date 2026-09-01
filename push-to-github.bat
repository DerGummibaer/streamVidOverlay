@echo off
echo Setting up and pushing to GitHub...

git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/DerGummibaer/streamVidOverlay.git
git push -u origin main

echo.
echo Done! Check https://github.com/DerGummibaer/streamVidOverlay to confirm.
echo Then go to Settings > Pages > Source > GitHub Actions to enable deployment.
pause

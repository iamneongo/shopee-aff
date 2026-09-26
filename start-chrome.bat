@echo off
REM Mo Chrome rieng cho Shopee Aff API (cong debug 9222, profile rieng).
REM Chay file nay TRUOC khi `npm start` (server se connect vao Chrome nay).
REM Dang nhap Shopee 1 lan trong cua so nay; profile se nho.

set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

start "" %CHROME% --remote-debugging-port=9222 --user-data-dir=C:\shopee-bot-profile --new-window "https://affiliate.shopee.vn/offer/custom_link"

echo.
echo Da mo Chrome (cong 9222, profile C:\shopee-bot-profile).
echo 1) Dang nhap Shopee trong cua so vua mo (neu chua).
echo 2) Chay: npm start
echo.

# TLS Certificates

## 開發環境（自簽憑證）

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -out image-converter.crt \
  -keyout image-converter.key \
  -days 365 -subj "/CN=localhost"
openssl dhparam -out dhparam.pem 2048
```

## 生產環境

使用 Let's Encrypt / Certbot 自動申請與續期。
憑證路徑對映在 docker-compose.yml 中。

**此目錄下的 .crt / .key 檔案已在 .gitignore 中排除。**

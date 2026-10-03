# Discord Shop — SMSCode + UI profesional

Bot toko Discord berbasis tombol dan dropdown.

## Panel
- `/shop` membuka panel utama
- 🛒 Beli OTP
- 💰 Saldo
- 📦 Pesanan Saya
- ❓ Bantuan
- Dropdown produk live dari SMSCode
- Konfirmasi pembelian
- Tombol Cek OTP
- Tombol Batalkan + refund
- Embed profesional

## Setup
1. Salin `.env.example` menjadi `.env`.
2. Isi token Discord, Application ID, password admin, dan token SMSCode.
3. `npm install`
4. `npm start`
5. Di Discord ketik `/shop`.

API SMSCode tetap memakai base URL `https://api.smscode.gg/v1` dan Bearer token.

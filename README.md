# Shop.M — Bot Toko Produk Digital & OTP

Bot Discord untuk menjual produk digital, OTP SMSCode, dan top up game otomatis melalui Digiflazz, dengan pembayaran saldo toko atau QRIS melalui TriPay/Midtrans.

## 1. Pasang atau perbarui

1. Ekstrak ZIP, lalu unggah file yang diperlukan ke root repository GitHub bot.
2. Pertahankan `package.json`, lockfile jika ada, dan aset repository asli. ZIP ini merupakan paket pembaruan, bukan repository lengkap.
3. Isi **Variables** di Railway menggunakan nama pada `.env.example`.
4. Pasang volume dengan Mount Path `/data`, lalu isi `DB_PATH=/data/shop.db`.
5. Jalankan bot dengan `node index.js`, tunggu deployment selesai, kemudian buka menu baru di Discord.

**Pembaruan terbaru:** ganti `payments.js`, `midtrans.js`, `shop-health.js`, `shop-tools.js`, dan `navigation.js`, serta README/panduan. Tidak ada dependency atau Variables baru.

**Jika penguatan Midtrans sebelumnya belum dipasang:** gunakan 5 file di atas ditambah `manual-products.js` dan `direct-payments.js` (total 7 file kode).

Paket berisi **57 file: 28 modul runtime, 26 file tes, dan 3 panduan/konfigurasi**. File `.test.js` dipakai untuk pengujian. Catatan perubahan lengkap tersedia di `CARA_PASANG.txt`.

## 2. Variables utama

| Variabel | Isi |
| --- | --- |
| `DISCORD_TOKEN` | Token bot Discord. |
| `OWNER_DISCORD_IDS` | ID owner; pisahkan beberapa ID dengan koma. |
| `ADMIN_DISCORD_IDS` | ID admin awal. Jika owner belum diisi, daftar ini menjadi fallback owner. |
| `SMSCODE_API_TOKEN` | Token API SMSCode. |
| `DB_PATH` | `/data/shop.db`, setelah volume `/data` terpasang. |
| `PAYMENT_GATEWAY` | `tripay` atau `midtrans` untuk tagihan baru. |

Variabel lain tersedia di `.env.example`. Dashboard web opsional memerlukan `ADMIN_PASSWORD` minimal 12 karakter dan `SESSION_SECRET` minimal 32 karakter.

Simpan token/secret di Railway Variables. Jangan unggah `.env`, database pelanggan, atau backup ke GitHub. Mengganti `DB_PATH` tidak otomatis memindahkan database lama.

## 3. Command dan menu

| Command | Fungsi |
| --- | --- |
| `/shop` | Buka toko; pembeli memilih bahasa sebelum mulai belanja. |
| `/admin` | Panel admin terdaftar. |
| `/ping` | Periksa respons bot, database, RAM, dan waktu berjalan; khusus admin. |

**Pembeli:** Beli OTP, Produk Lainnya, **Top Up Game**, Saldo, Pesanan, Isi Saldo, dan Bantuan. Riwayat pembelian digabung pada Pesanan. Minimal isi saldo **5.000 IDR**. Katalog produk digital hanya menampilkan nama; harga muncul pada detail/konfirmasi.

| Kategori admin | Fungsi utama |
| --- | --- |
| Toko | Produk digital, katalog OTP, varian, dan voucher. |
| Pembeli | Kelola pembeli, saldo, arsip, pencarian, dan tiket bantuan. |
| Pembayaran | Proses pesanan, verifikasi manual, pemeriksaan invoice, dan riwayat pembayaran. |
| Laporan | Penjualan OTP + produk digital, biaya, dan ekspor CSV. |
| Sistem | Akses server/channel/role, provider/webhook, backup, maintenance, dan pemeriksaan bot. |
| Ringkasan | Status operasional dan pekerjaan yang perlu ditangani. |

Admin terdaftar dapat membuka `/shop` di server/channel mana pun dan melalui DM. Pembeli memakai server yang disetujui serta mengikuti pembatasan channel/role dan izin Discord. Atur melalui **Sistem → Akses Bot → Server & Channel**. Menu Awal Admin kembali ke panel admin.

## 4. Tambahkan produk digital

Buka **Admin → Toko → Produk Lainnya → Kelola Produk**.

1. Pilih **Tambah Produk**, isi nama, deskripsi, dan harga.
2. **Ubah Produk** mengatur informasi; **Atur Harga Jual** mengatur harga.
3. Buka **Data Produk** untuk memasukkan akun/kode yang dikirim ke DM dan mengatur **Stok Jual**.
4. Aktifkan pengiriman otomatis jika stok jual dan data siap kirim tersedia.
5. Gunakan **Pratinjau Pesan** atau **Tes Beli** sebelum menjual. Tes Beli mengirim contoh ke DM admin tanpa memakai saldo/stok atau mencatat penjualan.

Satu data unik digunakan untuk satu pembelian. Stok jual dan data kirim disimpan terpisah. Pengiriman otomatis dilakukan setelah pembayaran terverifikasi; DM yang gagal masuk antrean percobaan ulang. Hapus Produk memakai konfirmasi dan tetap mempertahankan riwayat pesanan lama.


## 4A. Aktifkan Top Up Game Digiflazz

Isi Variables berikut di Railway:

- `DIGIFLAZZ_USERNAME` — username koneksi API Buyer.
- `DIGIFLAZZ_API_KEY` — API key Buyer.
- `DIGIFLAZZ_WEBHOOK_SECRET` — secret webhook untuk verifikasi callback.
- `DIGIFLAZZ_TESTING=true` saat pengujian; ubah `false` untuk produksi.
- `DIGIFLAZZ_CATEGORY=Games` untuk menampilkan kategori game.
- `DIGIFLAZZ_SYNC_MINUTES=15` untuk interval sinkron katalog.

Atur webhook Digiflazz ke `https://DOMAIN-BOT/webhooks/digiflazz` dan gunakan secret yang sama dengan `DIGIFLAZZ_WEBHOOK_SECRET`. Setelah deploy, katalog disinkron otomatis dan menu **Top Up Game** muncul di `/shop`. Pembayaran Top Up Game menggunakan saldo bot; member dapat mengisi saldo melalui sistem yang sudah ada. Status gagal mengembalikan saldo otomatis, sedangkan status pending dicek ulang dan dapat diperbarui melalui webhook.

## 5. QRIS dan webhook

Pilih gateway, isi kredensial sesuai mode, lalu daftarkan callback pada dashboard gateway.

| Gateway | Variables | Callback |
| --- | --- | --- |
| TriPay | `TRIPAY_API_KEY`, `TRIPAY_PRIVATE_KEY`, `TRIPAY_MERCHANT_CODE`, `TRIPAY_QRIS_CHANNEL`, `TRIPAY_IS_PRODUCTION` | `/api/payments/tripay/callback` |
| Midtrans | `MIDTRANS_SERVER_KEY`, `MIDTRANS_IS_PRODUCTION`, `MIDTRANS_QRIS_ACQUIRER` | `/api/payments/midtrans/callback` |

Gabungkan callback dengan **domain HTTPS publik service bot yang sebenarnya**. Contoh pola: `https://DOMAIN-BOT/api/payments/midtrans/callback`; ganti DOMAIN-BOT dengan domain Railway Anda.

Untuk webhook SMSCode, isi `SMSCODE_WEBHOOK_URL=https://DOMAIN-BOT/webhooks/smscode` dan `SMSCODE_WEBHOOK_SECRET` sesuai pengaturan provider/bot.

- Gunakan `false` untuk mode uji gateway dan `true` untuk produksi, dengan kredensial yang sesuai.
- Midtrans: default acquirer `gopay`; alternatif `airpay shopee` sesuai akun.
- Tes Midtrans: **Pembayaran → Pemeriksaan → Pencocokan Catatan → Midtrans → Tes Invoice**. Tes ini hanya membaca invoice yang sudah ada; pemrosesan memakai Cek Pembayaran pada invoice.
- Timeout/duplikasi invoice perlu diperiksa sebelum membayar ulang. Tenggat dan pengingat mengikuti expiry valid yang diterima dari provider.
- **Pencocokan Catatan → Refund Gateway** menampilkan satu catatan per invoice. Tandai selesai dengan alasan; riwayat menyimpan admin penanggung jawab. Nominal/status yang berubah membuka revisi invoice yang sama. Tindakan ini hanya menandai pemeriksaan, tidak melakukan refund atau debit saldo.
- **Pencocokan Catatan → Pantau Callback** memantau invoice belum dibayar berusia 15 menit. Maksimal 5 invoice per putaran dengan jeda 5 menit per invoice; pemeriksaan API terbaru dipakai ulang. Callback belum tercatat tidak berarti webhook rusak. Status lunas/kedaluwarsa atau callback terverifikasi mengeluarkan invoice dari antrean.
- Refund Midtrans ditandai untuk pencocokan admin; tidak otomatis mendebit saldo atau menghitung refund toko dua kali. Pesanan yang belum diproses ditahan jika refund terdeteksi. Biaya merchant perlu memakai nilai aktual, bukan perkiraan.

## 6. Cek setelah deploy

1. Buka `/shop`, `/admin`, dan `/ping` baru; tampilan pesan lama tidak otomatis berubah.
2. Periksa akses pembeli, katalog, saldo, stok/data, dan Tes DM/Tes Beli.
3. Uji pembayaran sesuai mode; pastikan callback dan pengiriman berjalan tepat sekali.
4. Gunakan Kesiapan Toko, Pesanan Terlambat, Pencocokan Catatan, dan Catatan Gangguan untuk pemeriksaan.
5. Atur backup owner melalui **Sistem → Data & Pemeliharaan**; unduh salinan terpisah dari volume bot.

**Validasi paket ini:** 4 tes khusus Digiflazz lulus. Pemeriksaan sintaks dilakukan pada seluruh modul runtime. Validasi 348 tes lama tetap berasal dari paket sebelumnya dan perlu dijalankan pada repository lengkap yang memiliki dependency proyek. Hasil ini belum memverifikasi akun Discord, Railway, atau gateway pengguna. Untuk menjalankan tes pada repository lengkap: `node --test *.test.js`.

# Shop.M — Toko Produk Digital dan OTP

Bot Discord untuk penjualan OTP melalui SMSCode dan produk digital seperti aplikasi premium, akun, atau kode aktivasi. Pembeli dapat membayar menggunakan saldo toko atau QRIS melalui TriPay/Midtrans yang telah dikonfigurasi.

Dokumentasi ini mengikuti kode terbaru per **3 Oktober 2026**, termasuk Beli Lagi produk digital, panduan pembeli baru, pratinjau pesan produk, ringkasan admin, dan kategori Sistem yang lebih ringkas.

## Tampilan toko

- Judul: **Hi, Belanja Produk Digital Yukk**.
- Deskripsi: **Selamat datang di Produk Digital by Maboyy**.
- Footer: **since 2020 • Andri Store**.
- Nama akun bot Discord diatur terpisah dari teks panel toko.

## Menu pembeli

| Menu | Kegunaan |
| --- | --- |
| Beli OTP | Pilih aplikasi, negara, operator yang tersedia, produk, dan metode pembayaran. |
| Produk Lainnya | Pilih produk digital; tombol katalog hanya menampilkan nama. Harga muncul pada detail dan konfirmasi. |
| Saldo | Lihat saldo pribadi melalui respons privat. |
| Pesanan | Riwayat pesanan gabungan, invoice, riwayat OTP, status pembayaran, dan hasil pesanan. |
| Isi Saldo | Pilih QRIS otomatis atau manual. Minimal isi saldo **5.000 IDR**. |
| Bantuan | Panduan pembeli baru, panduan refund, dan tiket bantuan. |

Pembeli menggunakan bot melalui server yang disetujui. DM bot khusus akses admin; hasil produk dan OTP tetap dapat dikirim ke DM pembeli. Saldo pribadi tidak ditampilkan pada teks panel awal toko.

### Beli Lagi

Buka **Pesanan → Riwayat Pesanan → Detail Pesanan → Beli Lagi**. Produk digital membuka konfirmasi baru menggunakan harga dan pengaturan produk terbaru. Tombol ini belum memotong saldo atau membuat pembayaran sampai pembeli melanjutkan. Produk yang dihapus, nonaktif, habis, atau sedang maintenance mengikuti pemeriksaan pembelian biasa. OTP tetap menggunakan alur Beli Lagi yang tersedia sebelumnya.

### Invoice dan pengiriman

- Pembayaran QRIS belum terkonfirmasi: buka detail invoice, lalu **Cek Pembayaran & Pesanan**. Gunakan invoice yang sama.
- Produk otomatis memakai satu data unik untuk satu pembelian setelah pembayaran terverifikasi.
- Produk dengan pengiriman manual menunggu admin memprosesnya.
- Aktifkan izin DM dari anggota server untuk menerima hasil. Hasil pesanan produk yang selesai juga tersedia pada detail pesanan pribadi.
- Saldo tidak cukup: pembeli diarahkan untuk menghubungi kontak admin yang ditentukan bagi server tersebut.

## Menu admin

Command tersedia: **`/shop`** dan **`/admin`**. Menu fitur lain menggunakan tombol/formulir.

| Kategori | Isi utama |
| --- | --- |
| Toko | OTP Provider, Produk Lainnya, dan Promo/Voucher. |
| Pembeli | Daftar saldo, cari pembeli, tambah saldo, riwayat saldo manual, dan tiket bantuan. |
| Pembayaran | Pesanan produk, pengajuan manual, pembayaran perlu diperiksa, topup tertunda, riwayat isi saldo/QRIS beli, dan petunjuk pembayaran manual. |
| Laporan | Penjualan hari ini/bulan ini, ekspor laporan, dan riwayat biaya gateway. |
| Sistem | Akses Bot, Provider & Webhook, Data & Pemeliharaan. |
| Ringkasan | Angka operasional yang perlu ditangani dan pintasan pemeriksaan. |

Tombol **Menu Awal Admin** kembali ke panel admin. Menu Awal pembeli kembali ke toko.

### Sistem

| Subkategori | Fitur |
| --- | --- |
| Akses Bot | Admin Toko; Server & Channel, termasuk role pengguna dan kontak admin server. |
| Provider & Webhook | Saldo Provider (Owner), Beli OTP Provider (Owner), Tes Webhook SMSCode, dan Peringatan Saldo. |
| Data & Pemeliharaan | Backup (Owner), Aktivitas Admin, dan Maintenance. |

### Daftar saldo pembeli

Pada **Admin → Pembeli → Daftar Saldo**, username dan ID Discord ditampilkan sekali per akun. Ringkasan menampilkan total saldo, jumlah akun, dan jumlah akun yang memiliki saldo. Gunakan **Semua Akun**, **Memiliki Saldo**, atau **Saldo Nol** untuk menyaring daftar. Pagination dan Perbarui mengikuti filter aktif; tidak mengubah saldo atau menghapus akun.

### Ringkasan admin terbaru

Menampilkan pengajuan isi saldo manual, pembelian OTP perlu pemeriksaan, tagihan QRIS aktif, pesanan produk menunggu admin, pesanan selesai dengan DM belum terkirim, produk aktif dengan stok jual/data otomatis menipis atau habis (**≤3**), dan status maintenance. Saldo provider hanya ditampilkan kepada owner.

**DM belum terkirim** mencakup antrean baru dan pengiriman yang belum berhasil. Klik **Segarkan** untuk memperbarui angka. Pintasan membuka pemeriksaan pembayaran, pesanan produk, dan katalog stok.

## Kelola produk digital

Buka **Admin → Toko → Produk Lainnya → Kelola Produk**.

1. **Tambah Produk** tersedia di dalam Kelola Produk.
2. Pilih produk untuk mengatur status aktif, harga jual, dan pengiriman otomatis.
3. **Ubah Produk** mengatur nama serta deskripsi; harga menggunakan **Atur Harga Jual**.
4. Dari Ubah Produk, buka **Data Produk** untuk menambah/mengubah data yang dikirim dan mengatur **Stok Jual**.
5. **Hapus Produk** meminta konfirmasi dan menyembunyikan produk dari katalog. Riwayat pesanan lama tetap tersimpan.

**Stok Jual** adalah batas jumlah yang dijual. **Data Produk** berisi akun/kode/pesan unik untuk dikirim. Keduanya disimpan terpisah, tetapi pengaturannya berada pada submenu Data Produk. Penjualan otomatis memerlukan stok jual yang cukup dan data kirim yang tersedia.

### Pratinjau Pesan dan Tes Beli

- **Data Produk → Pratinjau Pesan**: memperlihatkan contoh isi data yang tersedia secara privat kepada admin, termasuk sebelum produk diaktifkan. Tidak mengirim DM, membuat pesanan, memotong saldo, atau mengurangi stok.
- **Detail Produk → Tes Beli**: simulasi kesiapan pembelian produk digital dan pengiriman contoh ke DM admin. Ini tidak mencatat penjualan atau memakai stok untuk pembeli.
- Data yang sudah dialokasikan atau terjual tidak dapat diedit sebagai data tersedia.

## Owner, admin, server, channel, dan role

- Isi **OWNER_DISCORD_IDS** untuk menentukan owner secara eksplisit.
- Jika belum diisi, ID awal **ADMIN_DISCORD_IDS** menjadi owner mengikuti mekanisme fallback kode.
- Admin tambahan yang dipilih owner melalui bot bukan otomatis owner.
- Admin terdaftar dapat memakai `/shop` dari server/channel mana pun serta DM. Pembeli mengikuti izin server, channel, dan role yang diatur di bot.
- Server pembeli harus disetujui admin. Channel/role dapat dibatasi melalui **Sistem → Akses Bot → Server & Channel**.
- Bila role/channel tidak dibatasi di bot, pembeli tetap memerlukan server yang disetujui dan izin Discord untuk menggunakan aplikasi di channel tersebut.
- Kontak admin dapat ditentukan per server. Akun dan saldo pembeli tetap berbasis ID Discord secara global, bukan dompet terpisah per server.

## Pemasangan dan pembaruan

ZIP pembaruan berisi **21 file runtime JavaScript**, **19 file pengujian**, `.env.example`, panduan pemasangan, dan README ini. Gunakan ZIP sebagai pembaruan pada repository bot yang sudah berjalan; pertahankan `package.json`, lockfile, dan aset asli repository.

Untuk pembaruan dokumentasi ini saja, cukup tambahkan/ganti **README.md** di root GitHub. File runtime tidak berubah pada pembaruan README.

Untuk menjalankan kode, dependency utama yang digunakan adalah `discord.js`, `express`, `express-session`, `better-sqlite3`, dan `dotenv`. Gunakan Node.js yang mendukung dependency repository; pengujian terbaru dijalankan lokal pada Node.js 24.

```bash
# Pada repository lengkap yang mempunyai package.json:
npm install
node index.js
```

Jangan mengunggah `.env`, token, kunci gateway, database pembeli, atau backup berisi data pelanggan ke GitHub. `.env.example` hanya template nama variabel tanpa kredensial.

### Variabel Railway

| Variabel | Kegunaan |
| --- | --- |
| DISCORD_TOKEN | Token bot Discord. |
| DISCORD_CLIENT_ID | Application ID untuk pendaftaran command. |
| OWNER_DISCORD_IDS | ID Discord owner; pisahkan beberapa ID dengan koma. |
| ADMIN_DISCORD_IDS | ID admin awal/fallback owner bila OWNER_DISCORD_IDS kosong. |
| SMSCODE_API_TOKEN | Token akses SMSCode. |
| SMSCODE_API_BASE_URL | Default kode: `https://api.smscode.gg/v1`. |
| DB_PATH | Untuk volume `/data`, gunakan `/data/shop.db`. |
| SESSION_SECRET | Secret acak untuk sesi API admin web. |
| ADMIN_PASSWORD | Password akses API admin web bila digunakan. |
| MANUAL_TOPUP_INSTRUCTIONS | Petunjuk pembayaran manual awal. |
| PAYMENT_GATEWAY | Gateway tagihan baru: `tripay` atau `midtrans`. |
| PORT | Port layanan HTTP; gunakan konfigurasi port Railway yang berlaku. |

### Data persisten dan backup

Pasang volume pada service bot dengan **Mount Path `/data`**, lalu gunakan `DB_PATH=/data/shop.db`. Jika DB_PATH kosong dan Railway menyediakan RAILWAY_VOLUME_MOUNT_PATH, kode menggunakan `shop.db` pada volume tersebut. Tanpa keduanya, kode menggunakan `shop.db` di direktori kerja yang tidak cocok untuk data persisten deployment.

Database menyimpan pembeli, saldo, admin tambahan, pengaturan akses, produk, stok, pesanan, pembayaran, dan data operasional. Tabel/kolom tambahan dibuat oleh modul saat startup.

Jika data lama masih di luar volume, pindahkan dengan backup SQLite yang konsisten sebelum beralih lokasi database; mengganti DB_PATH saja tidak memindahkan data lama.

Backup owner tersedia pada **Sistem → Data & Pemeliharaan → Backup (Owner)**. Bot mendukung jadwal harian WIB, backup sekarang, unduh backup, dan menyimpan tujuh salinan terbaru. Default folder backup berada di samping database; dapat diubah memakai `BACKUP_DIR`.

Backup pada volume yang sama tidak melindungi dari hilangnya volume. Unduh dan simpan salinan terpisah. Fitur backup bot ini berbeda dari fitur backup platform Railway.

## QRIS otomatis

Pilih satu gateway untuk invoice baru melalui PAYMENT_GATEWAY. Akun merchant, kredensial, serta kanal QRIS gateway harus siap. Tombol QRIS dinonaktifkan bila konfigurasi gateway belum tersedia; mengunggah kode tidak otomatis mengaktifkan merchant.

### TriPay

Variabel: `TRIPAY_API_KEY`, `TRIPAY_PRIVATE_KEY`, `TRIPAY_MERCHANT_CODE`, `TRIPAY_QRIS_CHANNEL` (default `QRIS`), dan `TRIPAY_IS_PRODUCTION` (`false` untuk mode uji kode).

Alamat callback pada domain publik service:

```text
https://DOMAIN-ANDA/api/payments/tripay/callback
```

### Midtrans

Variabel: `MIDTRANS_SERVER_KEY`, `MIDTRANS_IS_PRODUCTION` (`false` untuk sandbox), dan `MIDTRANS_QRIS_ACQUIRER` (default `gopay`).

Alamat notifikasi pada domain publik service:

```text
https://DOMAIN-ANDA/api/payments/midtrans/callback
```

Bot memverifikasi callback/status gateway dan nominal tagihan sebelum mengisi saldo atau memenuhi pesanan. Pilihan gateway baru tidak mengubah gateway yang tersimpan pada invoice lama. Harga produk dan total tagihan, termasuk biaya pembeli jika ada, ditampilkan sebelum pembayaran.

## Webhook SMSCode

Gunakan domain publik HTTPS service bot, lalu isi:

```text
SMSCODE_WEBHOOK_URL=https://DOMAIN-ANDA/webhooks/smscode
SMSCODE_WEBHOOK_SECRET=SECRET-ACAK-ANDA
```

SMSCODE_API_TOKEN juga harus tersedia. Buat secret acak, misalnya melalui Console:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Simpan hasil pada Variables. Setelah deployment aktif, jalankan sekali pada Console service:

```bash
node smscode-webhook.js
```

Perintah tersebut mendaftarkan URL/secret ke SMSCode dan menjalankan tes endpoint. Jalankan ulang setelah URL atau secret berubah. Start Command bot tetap mengikuti repository, biasanya `node index.js`.

**Admin → Sistem → Provider & Webhook → Tes Webhook SMSCode** memeriksa konfigurasi dan meminta tes endpoint. Tes ini tidak membeli nomor, membuat riwayat pembelian, atau mengubah saldo. Hasil HTTP 200 belum membuktikan pengiriman OTP dari transaksi nyata.

Webhook memverifikasi signature, menyimpan antrean, lalu memeriksa order terbaru melalui API. Hanya order lokal bot yang diperbarui; pembelian di luar bot tidak otomatis menjadi pesanan pelanggan. Polling tetap tersedia sebagai cadangan.

## Saldo provider dan pembelian owner

Buka **Admin → Sistem → Provider & Webhook**. Saldo SMSCode dan pembelian langsung memakai saldo provider hanya tersedia bagi owner.

Pilih **Beli OTP Provider (Owner)**, telusuri produk, lalu **Beli Pakai Saldo Provider (Owner)**. Konfirmasi menampilkan biaya provider. Ini pembelian nomor sungguhan yang mengurangi saldo SMSCode; tidak memakai saldo pembeli atau markup toko. Pesanan owner tercatat pada riwayat owner dengan penanda khusus dan dikecualikan dari laporan penjualan pelanggan.

## Pemeriksaan setelah deploy

1. Buka `/shop` dan `/admin` baru. Pesan panel lama tidak otomatis diperbarui.
2. Cek akses pembeli di server/channel/role yang dipilih dan penolakan DM pembeli.
3. Periksa saldo, katalog, serta stok/data produk yang tersimpan.
4. Coba Pratinjau Pesan dan Tes Beli produk digital sebelum mengaktifkan penjualan.
5. Periksa konfigurasi gateway dan tes pembayaran sesuai mode gateway sebelum transaksi produksi.
6. Tes endpoint SMSCode; bila menguji pembelian owner, siapkan saldo provider untuk transaksi nyata.
7. Unduh backup dan pastikan database berada pada volume yang benar.

Pengujian kode terbaru sebelumnya: **209 tes lokal lulus**. Ini bukan konfirmasi deployment Railway atau transaksi live pada akun pengguna. Pengujian lokal menggunakan basis data/API tiruan untuk memeriksa perilaku aplikasi.

```bash
node --test *.test.js
```

File `.test.js` digunakan untuk pengujian; tidak menjadi Start Command bot. Panduan perubahan terdahulu tersimpan di `CARA_PASANG.txt`; README ini merangkum perilaku terbaru.

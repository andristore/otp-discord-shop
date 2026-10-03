## Status transaksi dan pemeriksaan operasional — pembaruan terbaru

**13 file runtime berubah dari paket sebelumnya:** index.js, payments.js, direct-payments.js, operations.js, shop-tools.js, manual-products.js, order-history.js, premium-products.js, languages.js, shop-improvements.js, shop-health.js, web-security.js, store-features.js. Jika paket sebelumnya sudah terpasang, unggah 13 file ini. Jika belum, gunakan seluruh 27 modul runtime. Paket tetap 55 file: 27 runtime, 25 tes, README.md, CARA_PASANG.txt, .env.example. Tidak ada dependency atau Variables baru. Pertahankan package.json, database, dan volume; jangan mengunggah database produksi atau rahasia ke GitHub.

- Riwayat/invoice membedakan pembayaran terverifikasi, proses admin, menunggu OTP, data siap tetapi DM belum berhasil, dan DM terkirim. Status DM mengikuti penanda pengiriman tersimpan. Laporan channel juga membedakan pesanan selesai dan status DM. Pembayaran produk tidak ditampilkan sebagai isi saldo.
- Pencarian admin yang sudah ada menerima username, ID Discord, invoice produk, dan referensi OTP. Hasil satu akun hanya muncul sekali; hasil dibatasi per halaman dan sesi pencarian berlaku 15 menit. Hak admin diperiksa kembali.
- Catatan Gangguan memakai menu yang sudah ada. Owner menerima ringkasan kegagalan pembayaran/provider/webhook/pengiriman yang tercatat dalam 24 jam terakhir, maksimal sekali per kategori per 15 menit. Kegagalan DM dicoba paling cepat satu menit kemudian; owner dapat menonaktifkan peringatan. Ringkasan tidak menyertakan token atau isi akun. Ini bukan pemantau bot saat proses bot mati.
- Kesiapan Toko menyediakan Periksa Stok untuk produk otomatis aktif yang stok jualnya melebihi data siap kirim. Pemeriksaan tidak mengubah stok atau data secara diam-diam. Stok jual dan data produk tetap terpisah.
- Backup baru diperiksa dengan SQLite integrity_check, foreign_key_check, serta tabel wajib pada salinan terisolasi sebelum dijadikan backup terakhir. Backup gagal tidak menggantikan backup valid sebelumnya. Batas pemeriksaan 64 MB; tes ini tidak melakukan restore ke database aktif. Backup pada volume yang sama tetap perlu salinan terpisah untuk melindungi dari kehilangan volume.
- Bahasa Inggris diperluas pada status transaksi, instruksi QRIS, notifikasi stok/masa aktif/dukungan, dan pesan kesalahan. Nama produk, deskripsi, panduan, respons admin, serta data akun/kode buatan admin dipertahankan. Tidak menjanjikan terjemahan otomatis semua konten admin.

**Validasi: 310 tes lokal lulus dan 27 modul runtime lolos pemeriksaan sintaks.** Tes mencakup akses, pembayaran berulang, status DM, pencarian, backup gagal, retry/notifikasi, serta ID komponen. Belum diuji pada Discord/Railway/provider milik pengguna; hasil lokal bukan jaminan tanpa error di layanan eksternal. Setelah deploy, buka menu baru dari /admin dan /shop; pesan lama tidak otomatis berubah. Uji invoice, DM tertutup, dan tujuan channel sebelum memakai transaksi nyata.

### Channel informasi maintenance dan pengumuman

Buka **/admin → Sistem → Data & Pemeliharaan → Maintenance → Channel Informasi**. Owner memilih **Atur Channel**, mengisi ID server/channel teks, lalu **Tes Channel**. Bot harus berada di server tujuan dan memiliki View Channel serta Send Messages. Channel informasi terpisah dari channel laporan pesanan. Pengaturan tidak memindahkan channel akses /shop.

Setelah diaktifkan, perubahan maintenance benar-benar dari nonaktif menjadi aktif, atau sebaliknya, membuat satu pengumuman otomatis. Menekan tombol yang sama tidak membuat pengumuman kedua. Mengatur channel pertama kali tidak langsung mengirim status lama; gunakan Tes Channel. Admin aktif dapat membuat info lain lewat **Buat Pengumuman → Pratinjau → Kirim ke Channel**; hanya pembuat dapat mengonfirmasi dan pratinjau kedaluwarsa 15 menit. Isi pengumuman publik, jangan masukkan password, token, atau data akun pembeli. Mention @everyone/role/user tidak memicu notifikasi.

Antrean tersimpan setelah restart, maksimal 20 menunggu dan 5 dikirim per putaran sekitar 30 detik. Kegagalan izin/koneksi dicoba lagi paling cepat satu menit. Antrean/Pernah Gagal ditampilkan di menu. Nonaktifkan Info menghentikan pengiriman; mengaktifkan lagi melanjutkan antrean. Mengganti tujuan membatalkan antrean/pratinjau lama agar tidak terkirim ke server baru. Admin yang dicabut aksesnya tidak dapat mengirim pengumuman yang masih menunggu. Riwayat terkirim/dibatalkan dibersihkan setelah 30 hari. Fitur ini mengikuti perubahan maintenance oleh admin, bukan pendeteksi otomatis ketika proses bot/Railway mati. Jika proses mati setelah Discord menerima pesan tetapi sebelum sukses tersimpan, pengiriman ulang masih mungkin.

Bagian di bawah mencatat pembaruan sebelumnya; daftar file di bagian paling atas adalah daftar unggahan rilis ini.

---

## Laporan pesanan selesai ke channel tertentu — pembaruan terbaru

**3 file runtime berubah:** index.js, admin.js, order-history.js. Unggah ketiganya jika rilis operasional sebelumnya sudah terpasang. Jika belum, gunakan seluruh 27 modul runtime dari ZIP lengkap. Tidak ada dependency atau Variables baru; pertahankan package.json, database, dan volume. Paket tetap 55 file.

Buka **/admin → Laporan → Channel Pesanan Selesai → Atur Channel** sebagai owner. Isi ID server dan ID channel teks tujuan. Bot harus berada di server tersebut dan memiliki izin View Channel, Send Messages, Embed Links. Di iPhone, aktifkan Developer Mode Discord lalu salin ID server dan channel. Channel laporan terpisah dari channel akses pembelian; tidak mengubah izin /shop. Hanya owner dapat mengubah tujuan, menonaktifkan, melakukan tes, dan mengirim riwayat lama. Admin terdaftar dapat melihat ringkasan pengaturan.

Pilih **Tes Channel** untuk memastikan pesan dapat dikirim. Pesanan baru yang selesai dilaporkan otomatis setiap sekitar 30 detik, maksimal 10 per putaran. OTP dianggap berhasil saat status provider OTP_RECEIVED atau COMPLETED; perubahan status berikutnya tidak menghasilkan laporan kedua. Produk digital otomatis maupun yang diselesaikan admin memakai status completed. OTP menggunakan saldo/QRIS hanya dilaporkan sekali dari pesanan, bukan sekali lagi dari invoice. Pembelian provider khusus owner/test, refund, pesanan dibatalkan, dan pembayaran belum selesai tidak dilaporkan. Tes kirim produk ke DM tidak membuat laporan penjualan.

Isi laporan: username jika tersimpan, satu ID pembeli, nama produk/varian, jenis, harga produk, metode pembayaran, invoice/referensi saldo, status selesai, serta tanggal pesanan UTC. Harga adalah harga produk, bukan total tagihan beserta biaya gateway. Nomor telepon, OTP/SMS, akun, password, data produk, dan deskripsi tidak dikirim ke channel. Mention dinonaktifkan. Siapa pun yang dapat membaca channel tujuan dapat membaca ringkasan transaksi; gunakan channel sesuai kebutuhan privasi toko.

Saat pertama diaktifkan, riwayat lama tidak dikirim otomatis. **Kirim Riwayat Lama** menampilkan konfirmasi lalu memasukkan semua pesanan selesai yang belum pernah dilaporkan. Proses berjalan bertahap; jumlah Antrean/Terkirim bisa dilihat lewat Perbarui. Pesanan selesai selama fitur dinonaktifkan akan menyusul setelah diaktifkan lagi. Mengganti channel tidak mengirim ulang laporan yang sudah berhasil ke channel lama. Antrean dan penanda terkirim tersimpan di database setelah restart. Kegagalan izin/kirim dicoba lagi paling cepat satu menit kemudian, tanpa mengubah saldo, stok atau pengiriman DM pembeli. Status selesai berarti pesanan sudah selesai pada database; DM pembeli yang gagal tetap ditangani lewat fitur retry DM tersendiri. Jika koneksi/proses terputus setelah Discord menerima pesan tetapi sebelum penanda sukses tersimpan, pengiriman ulang masih mungkin terjadi.

**Validasi: 296 tes lokal lulus**, termasuk privasi laporan, akses owner/admin, tujuan salah, izin hilang, retry, restart, konkurensi, batas batch, riwayat lama, deduplikasi OTP/invoice, dan konfigurasi nonaktif. Belum diuji pada akun Discord/Railway pengguna. Setelah unggah dan deployment berhasil, buka /admin baru lalu atur tujuan.

---

## Pengembangan operasional terbaru — tanpa perpanjangan langganan

**6 file runtime berubah:** index.js, manual-products.js, payments.js, shop-health.js, languages.js, navigation.js. Tidak ada dependency, modul runtime atau Variables baru. Jika rilis audit sebelumnya belum dipasang, gunakan seluruh 27 modul runtime dari paket lengkap. ZIP tetap 55 file: 27 runtime, 25 tes, 3 dokumentasi/contoh konfigurasi. Pertahankan package.json, database dan volume.

### Antrean pengerjaan admin

/admin → Pembayaran → Pesanan & Verifikasi → Pesanan Produk menyediakan **Semua**, **Antrean**, **Tugas Saya**. Pesanan menunggu admin diurutkan dari yang paling lama (tanggal pembuatan pesanan). Buka detail lalu **Ambil Pesanan**. Penanggung jawab tersimpan setelah restart. Admin lain tidak dapat menyelesaikan atau me-refund pesanan tersebut; tombolnya dinonaktifkan dan pemeriksaan transaksi tetap menolak tombol/form lama yang dicoba kembali. Penanggung jawab dapat **Lepas Penugasan**; owner juga dapat melepasnya untuk dipindahkan. Jika penanggung jawab sudah dicabut akses adminnya, admin aktif lain dapat mengambil pesanan. Penyelesaian pesanan yang belum diambil tetap menetapkan admin pelaksana. Pengambilan tidak mengubah saldo/stok, dan penugasan tidak mengubah status pesanan menjadi status tambahan.

### Peringatan stok per produk/varian

/admin → Toko → Produk Lainnya → Kelola Produk → pilih produk/varian → Data & Stok → **Peringatan Stok**. Batas 0–1.000.000, kosong = nonaktif (bawaan). Nilai 0 berarti beri tahu saat habis. Produk manual memakai stok jual yang diatur; stok yang belum diatur tidak dianggap nol. Produk otomatis memakai jumlah yang benar-benar bisa dikirim: minimum stok jual dan data tersedia, atau data tersedia jika stok jual mengikuti data. Peringatan dikirim ke DM admin aktif, tanpa akun/kode produk.

Satu notifikasi berhasil per admin selama stok tetap pada/di bawah batas. Setelah pemeriksaan melihat stok di atas batas, notifikasi aktif lagi jika stok turun. Mengubah batas atau menonaktifkan/mengaktifkan produk juga mengawali siklus baru. Stok yang naik lalu turun sebelum pemeriksaan berikutnya mungkin tidak teramati sebagai siklus baru. Pemeriksaan mengikuti polling produk 30 detik, maksimal 10 konfigurasi dan 5 percobaan DM per putaran; toko besar dapat membutuhkan beberapa putaran. DM gagal dicoba lagi, tanpa menandainya berhasil. Ini peringatan admin; notifikasi stok tersedia kembali bagi pembeli yang sudah ada tetap terpisah.

### Riwayat perubahan produk

Kelola Produk → pilih produk/varian → Ubah Produk → **Riwayat Perubahan** → pilih **Perubahan #...**. Catat admin, waktu, nilai sebelum/sesudah nama, deskripsi, harga, modal, stok jual, status aktif, kirim otomatis, penghapusan dan batas peringatan. Penambahan/perubahan data hanya mencatat ID serta jumlah data, tidak isi akun/kode. Rekaman mulai sejak pembaruan, maksimal 300 catatan per produk. Pengubahan data yang sama tanpa perubahan tidak menambah catatan; pengiriman ulang form yang sama tidak menggandakan perubahan. Perubahan dan catatan dibatalkan bersama jika audit gagal. Penjualan/reservasi otomatis bukan pengubahan admin dan tetap memakai riwayat transaksi/stok asli. Pengaturan panduan/durasi/garansi tetap memakai fitur premium yang sudah ada; fitur ini tidak menambahkan perpanjangan.

### Pengingat invoice

Invoice TriPay **baru** menyimpan batas 20 menit yang diminta saat membuat tagihan. Dalam 5 menit terakhir, bot memeriksa status melalui API gateway dahulu, lalu mengirim satu pengingat berhasil ke DM pemilik invoice. Tidak membuat invoice baru, memotong saldo/stok, memberi refund, atau menyatakan gagal hanya karena waktu lewat. Invoice lunas, tidak aktif, tidak punya QR, sudah melewati waktu, atau tidak mempunyai batas tersimpan dilewati. Pemeriksaan mengikuti polling kesiapan toko tiap menit, maksimal 5 invoice per putaran. Kegagalan API/DM dicoba lagi paling cepat setelah satu menit selama masih dalam jendela pengingat. English mengikuti bahasa pembeli. DM yang tertutup tidak menghalangi pengecekan melalui Pesanan → Invoice di server toko.

Invoice lama dan invoice Midtrans tanpa batas tersimpan **tidak menggunakan perkiraan kedaluwarsa** sehingga tidak diberi pengingat ini. Konfirmasi/pengecekan pembayaran lama tetap tersedia. Penanda pengingat dan penugasan tersimpan setelah restart; seperti pengiriman DM lain, koneksi terputus setelah pesan terkirim tetapi sebelum penanda tersimpan masih dapat menimbulkan pengiriman ulang.

**Validasi rilis: 289 tes lokal lulus**, termasuk hak admin/owner, penugasan konflik, rollback, urutan antrean, privasi/retensi perubahan, notifikasi setelah restart, rearm stok, konkurensi polling, pembayaran yang lunas saat pemeriksaan, retry dan bahasa pengingat. Seluruh 27 modul lolos syntax check. Belum diuji pada akun Discord/Railway/provider pengguna. Unggah enam file di atas lalu buka /admin dan /shop baru setelah deployment berhasil.

---

## Pemeriksaan seluruh kode — rilis terbaru

**Hasil: 27 modul runtime diperiksa, 277 tes lokal lulus.** Semua impor file lokal tersedia dan seluruh modul lolos syntax check. Pemindaian blok identik lintas modul tidak menemukan salinan persis enam baris berurutan sepanjang lebih dari 180 karakter; ini bukan bukti bahwa semua fungsi secara semantik bebas kemiripan.

### Perbaikan dari pemeriksaan ini

1. Menghapus tujuh implementasi handler yang tidak terpakai karena sudah ditangani modul lain: riwayat OTP lama di index, ringkasan Pesanan Saya lama di efficiency, riwayat QRIS lama di direct-payments, riwayat produk pembeli lama di manual-products, serta pembayaran bermasalah dan dua halaman owner provider lama di admin. Tombol lama tetap didukung oleh order-history, operations dan owner-provider; tidak menghapus transaksi/database.
2. Memperbaiki baris kosong setelah penggabungan tombol Menu Awal Admin. Sebelum menu dikirim melalui navigasi utama, periksa ID duplikat (termasuk tombol nonaktif), panjang ID, batas baris/tombol, serta dropdown pada baris tersendiri. Jika menu tidak valid, hentikan pengiriman payload tersebut dan gunakan penanganan kesalahan; pemeriksaan ini tidak menyembunyikan duplikasi dengan mengganti ID sembarangan.
3. Pemeriksaan origin dashboard mencakup seluruh /api, termasuk endpoint pesanan dan saldo. Callback gateway tetap pada jalur verifikasi tanda tangan yang dipasang sebelum session/origin guard, sehingga tidak memerlukan cookie browser.
4. Menghapus helper smsFinish yang tidak digunakan. Logika pembelian/refund/garansi tetap pada modul masing-masing.

### File untuk dipasang

Jika sudah memasang rilis audit sebelumnya (yang menambahkan web-security.js), ganti **6 file kode**: index.js, admin.js, efficiency.js, direct-payments.js, manual-products.js, navigation.js. README.md dan CARA_PASANG.txt juga diperbarui. Tidak ada dependency atau modul runtime baru pada rilis ini.

Jika belum memasang rilis audit sebelumnya, gabungkan daftar di atas dengan delapan file dari bagian berikutnya: total **12 file kode berbeda**. Untuk pemasangan paket penuh, gunakan semua **27 file .js runtime**, tanpa file *.test.js. Pertahankan package.json yang sudah digunakan. ZIP tetap berisi **55 file**: 27 runtime, 25 file tes, README.md, CARA_PASANG.txt, dan .env.example.

### Cakupan dan batas pemeriksaan

Tes mencakup katalog/paginasi, tombol/navigasi, registrasi /shop /admin /ping, hak owner/admin/pembeli, server/channel/role dan DM, bahasa, produk/varian/garansi, stok dan data unik, pembayaran saldo/QRIS, callback dan pemulihan invoice, refund, voucher, riwayat milik pembeli, bukti manual, tiket, backup, arsip pembeli, laporan dan keamanan dashboard. Handler pembayaran gateway, DM gagal dan produk pending mempunyai fungsi berbeda walau berada dalam kategori pemeriksaan yang sama.

Klaim garansi dan pengingat masa aktif **sudah ada** dalam premium-products.js. Jangan menambah implementasi garansi kedua. Shortcut seperti Ringkasan menuju modul utama merupakan navigasi, bukan proses transaksi terpisah. Fungsi pembentuk tombol/format angka yang pendek pada modul berbeda masih dapat mirip; penyatuan seluruh helper kosmetik tidak diperlukan untuk mencegah transaksi ganda.

Belum menguji login Discord, deployment Railway, pembayaran sungguhan atau pengiriman provider dengan akun pengguna. Konfigurasi token, domain webhook dan izin channel tetap perlu diuji sesudah deployment. Hasil lokal tidak menjamin provider/jaringan tidak pernah error. Jangan menghapus shop.db, volume atau Variables. Buka /admin dan /shop baru setelah deploy; pesan lama tidak otomatis ditulis ulang.

---

## Pembaruan terbaru: hasil audit dan perbaikan

Ganti 7 file kode: `index.js`, `payments.js`, `manual-products.js`, `shop-tools.js`, `smscode-webhook.js`, `languages.js`, `shop-health.js`. Tambahkan `web-security.js`. Total **8 file kode** untuk pembaruan ini, pada folder yang sama dengan package.json. Jangan hanya mengganti index.js karena file baru wajib tersedia. Tidak ada dependency baru atau kewajiban membuat package-lock.json. Paket lengkap berisi **55 file**, termasuk **27 modul runtime**, 25 file tes, dan 3 file dokumentasi/contoh konfigurasi. Pertahankan package.json yang sudah dipakai di repository.

- Invoice TriPay yang ditolak secara pasti membebaskan stok produk satu kali. Timeout atau hasil yang belum pasti tetap menahan stok untuk mencegah pembayaran/penjualan ganda. `/admin → Pembayaran → Pemeriksaan → Cocokkan Transaksi → Pulihkan Referensi TriPay` menerima ID invoice bot dan referensi asli dari dashboard TriPay. Bot membaca status dari API gateway dan memeriksa identitas/nominal sebelum memprosesnya. Tidak membuat pembayaran baru. Jika gateway tidak menyediakan referensi, konfirmasikan ke provider dahulu; bot tidak menganggap timeout sebagai pembayaran gagal.
- Tiket bantuan mengenali pesanan OTP, produk digital, serta invoice milik pembeli. Referensi milik pengguna lain tetap ditolak.
- `/admin → Sistem → Data & Pemeliharaan → Kesiapan Toko → Catatan Gangguan` menyimpan maksimal 100 kelompok gangguan dengan kode, referensi dan jumlah kejadian. Tidak menyimpan pesan mentah, akun produk, OTP atau API key. Catatan baru dikumpulkan sejak pembaruan.
- Tes dan konfigurasi webhook SMSCode menolak URL contoh `domain-anda` sebelum mengirim permintaan. Gunakan domain HTTPS publik bot Railway dengan path `/webhooks/smscode`, dan samakan URL/secret dengan SMSCode. Diagnosis 422 dapat menampilkan kode provider yang dikenali; ini membantu pemeriksaan, bukan menjamin webhook langsung berhasil.
- Backup: owner dapat memilih **Aktifkan Salinan DM** di menu Backup lalu **Backup Sekarang**. Bawaan nonaktif. Salinan hanya dikirim ke owner yang masih berwenang; kegagalan dicoba lagi pada pemeriksaan berikutnya. Unduh file DM dan simpan aman. Pengiriman maksimal 8 MB. Jadwal dan penyimpanan tujuh backup lokal tetap tersedia; salinan pada volume yang sama tidak melindungi dari penghapusan volume.
- Dashboard web hanya aktif jika `SESSION_SECRET` minimal 32 karakter dan `ADMIN_PASSWORD` minimal 12 karakter. Jika belum memenuhi, login dashboard mendapat 503; bot Discord dan endpoint webhook tetap berjalan. Cookie aman pada produksi/Railway, login dibatasi 10 percobaan per IP per 15 menit, sesi diganti setelah login. Perubahan melalui dashboard harus berasal dari origin yang sama; klien API dengan sesi admin juga perlu header Origin yang sesuai. Simpan rahasia di Variables Railway.
- Padanan English ditambah untuk tombol dan pesan perbaikan ini. Teks admin/provider yang belum mempunyai padanan tetap asli.

**Validasi:** 274 tes lokal lulus; syntax seluruh modul runtime diperiksa. Belum diuji langsung pada akun Discord/Railway/gateway pengguna. Unggah file terbaru, tunggu deployment berhasil, lalu buka pesan `/admin` atau `/shop` baru. Perbaikan registrasi `/ping` dari versi sebelumnya tetap disertakan; cari log `Command Discord berhasil didaftarkan: /shop, /admin, /ping` setelah restart.

Panduan di bawah memuat riwayat pembaruan. Untuk daftar file pembaruan saat ini, gunakan daftar di bagian paling atas. Jangan menghapus shop.db, volume, atau Variables lama. Jangan mengunggah .env/credential.

# Shop.M — Toko Produk Digital dan OTP

Bot Discord untuk penjualan OTP melalui SMSCode dan produk digital seperti aplikasi premium, akun, atau kode aktivasi. Pembeli dapat membayar menggunakan saldo toko atau QRIS melalui TriPay/Midtrans yang telah dikonfigurasi.

Dokumentasi ini mengikuti kode terbaru per **3 Oktober 2026**, termasuk pemeriksaan kesiapan toko, peringatan keterlambatan, pencocokan catatan transaksi, tes pemulihan backup, serta modal produk dan keuntungan sementara.

Perbaikan terbaru: detail varian memakai satu tombol kembali ke daftar varian, sehingga tidak ada ID tombol berulang. Jika versi sebelumnya sudah terpasang, cukup ganti `manual-products.js` lalu buka menu baru setelah deployment. 260 tes lokal lulus.

## Tampilan toko

- Judul: **Hi, Belanja Produk Digital Yukk**.
- Deskripsi: **Selamat datang di Produk Digital by Maboyy**.
- Footer: **est. 2020 — Bot Otomatis 24/7**.
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
| Pembeli | Daftar saldo, kelola/arsip/hapus pembeli, cari pembeli, tambah saldo, riwayat saldo manual, dan tiket bantuan. |
| Pembayaran | Pesanan produk, pengajuan manual, pembayaran perlu diperiksa, topup tertunda, riwayat isi saldo/QRIS beli, dan petunjuk pembayaran manual. |
| Laporan | Penjualan gabungan OTP dan produk digital hari ini/bulan ini, ekspor CSV, dan riwayat biaya gateway. |
| Sistem | Akses Bot, Provider & Webhook, Data & Pemeliharaan. |
| Ringkasan | Angka operasional yang perlu ditangani dan pintasan pemeriksaan. |

Tombol **Menu Awal Admin** kembali ke panel admin. Menu Awal pembeli kembali ke toko.

### Sistem

| Subkategori | Fitur |
| --- | --- |
| Akses Bot | Admin Toko; Server & Channel, termasuk role pengguna dan kontak admin server. |
| Provider & Webhook | Saldo Provider (Owner), Beli OTP Provider (Owner), Tes Webhook SMSCode, dan Peringatan Saldo. |
| Data & Pemeliharaan | Backup (Owner), Aktivitas Admin, Maintenance, dan Ping & Kecepatan Bot. |

### Daftar saldo pembeli

Pada **Admin → Pembeli → Daftar Saldo**, username dan ID Discord ditampilkan sekali per akun. Ringkasan menampilkan total saldo, jumlah akun, dan jumlah akun yang memiliki saldo. Gunakan **Semua Akun**, **Memiliki Saldo**, atau **Saldo Nol** untuk menyaring daftar. Pagination dan Perbarui mengikuti filter aktif; tidak mengubah saldo atau menghapus akun.

### Hapus pembeli dan arsip otomatis

Buka **Admin → Pembeli → Kelola Pembeli** untuk melihat daftar **Aktif**, **Arsip**, dan **Dihapus**. Pilih akun untuk mengarsipkan atau memulihkannya. **Hapus Pembeli** hanya untuk owner, meminta konfirmasi, serta mensyaratkan saldo 0 dan tidak ada pesanan/pembayaran/pengajuan/pengiriman tertunda. Penghapusan merupakan penghapusan dari daftar aktif; akun dan riwayat transaksi tetap tersimpan.

Arsip otomatis berlaku bagi **semua akun pembeli** setelah **30 hari tidak menggunakan bot**, termasuk akun yang memiliki saldo atau proses tertunda. Arsip hanya status daftar: saldo, riwayat, pengiriman, dan pemeriksaan pembayaran tetap berjalan. Daftar Saldo menampilkan akun aktif; saldo akun arsip dapat diperiksa dari Kelola Pembeli → Arsip.

Aktivitas dihitung dari interaksi pengguna yang lolos izin bot, bukan pesan chat biasa, status online Discord, pembacaan profil oleh admin, atau callback gateway. Saat pembeli memakai bot lagi, akun aktif kembali dan hitungan 30 hari dimulai ulang. Akun lama yang belum memiliki catatan aktivitas mulai dihitung dari pemasangan fitur ini. Pemeriksaan arsip berlangsung saat startup dan tiap jam, maksimal 100 akun per pemeriksaan. Data aktivitas/status disimpan pada database volume.

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

## Ping dan kecepatan bot

Buka **Admin → Sistem → Data & Pemeliharaan → Ping & Kecepatan Bot**. Respons privat menampilkan latensi heartbeat Discord, waktu proses hingga respons awal, durasi query database, RAM proses, dan waktu berjalan. Tekan **Tes Ulang** untuk nilai terbaru. Waktu menggunakan satuan milidetik; bukan ukuran bandwidth internet dalam Mbps. Tes ini tidak memanggil provider atau membuat transaksi.

## Pemasangan dan pembaruan

ZIP pembaruan berisi **22 file runtime JavaScript**, **20 file pengujian**, `.env.example`, panduan pemasangan, dan README ini. Gunakan ZIP sebagai pembaruan pada repository bot yang sudah berjalan; pertahankan `package.json`, lockfile, dan aset asli repository.

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
| DISCORD_CLIENT_ID | Opsional; Application ID diambil langsung dari token bot untuk pendaftaran command. |
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

Pengujian kode terbaru sebelumnya: **240 tes lokal lulus**. Ini bukan konfirmasi deployment Railway atau transaksi live pada akun pengguna. Pengujian lokal menggunakan basis data/API tiruan untuk memeriksa perilaku aplikasi.

```bash
node --test *.test.js
```

File `.test.js` digunakan untuk pengujian; tidak menjadi Start Command bot. Panduan perubahan terdahulu tersimpan di `CARA_PASANG.txt`; README ini merangkum perilaku terbaru.

Pembaruan: menu Pembeli → Kelola Pembeli mengelompokkan Pengguna Bot, Daftar Saldo, dan Cari Pembeli dengan tombol abu-abu. Owner dan admin terdaftar dilindungi dari penghapusan akun pembeli; penghapusan pembeli biasa tetap khusus owner, saldo nol, dan tidak ada proses tertunda. Arsip otomatis 30 hari tetap berjalan sebagaimana pengaturan sebelumnya.

Tes webhook kini membedakan kesalahan API SMSCode (HTTP 401/403/429/5xx), batas waktu, DNS, respons JSON tidak valid, dan kode HTTP pengiriman ke bot. Token, secret, serta isi respons provider tidak ditampilkan. Diagnostik ini tidak membuktikan penyebab kegagalan akun live sebelum tes ulang.

## Produk premium: varian, garansi, dan notifikasi

- **Admin → Toko → Produk Lainnya → Kelola Produk → pilih produk → Pengaturan → Varian, Panduan & Garansi**. Tambahkan varian (misalnya 1 Bulan Sharing / 3 Bulan Private). Varian memiliki harga, stok jual, dan Data Produk terpisah; stok awal varian 0 sehingga belum dapat dibeli. Atur stok serta pengiriman pada detail varian. Katalog utama tetap menampilkan nama produk utama; pembeli memilih varian pada detail produk.
- **Panduan & Masa Aktif**: durasi aktif dan garansi dalam hari (0 = nonaktif), panduan maksimum 1500 karakter. Varian baru menyalin pengaturan produk utama saat dibuat; perubahan selanjutnya diatur pada masing-masing varian. Panduan dikirim bersama hasil pesanan lewat DM dan dapat dibaca di riwayat pesanan pribadi.
- Pengaturan disimpan pada pesanan saat checkout. Masa aktif dan garansi mulai ketika pesanan berstatus selesai, termasuk setelah QRIS terverifikasi. Pesanan lama sebelum fitur ini tidak diberi garansi atau masa aktif secara retroaktif. Perubahan produk tidak mengubah pengaturan pembelian sebelumnya.
- Pengingat DM dikirim saat sisa masa aktif <= 3 hari, selama belum berakhir. Untuk membeli kembali, buka Riwayat Pesanan di server → Beli Lagi; transaksi baru tidak memperpanjang akun lama secara otomatis. DM tetap untuk pengiriman data/notifikasi; akses pembeli mengikuti izin server/channel.
- Pembeli: Riwayat Pesanan → pilih pembelian selesai → Klaim Garansi. Garansi harus aktif, invoice harus milik pembeli, satu klaim per pesanan. Klaim yang sudah diajukan dapat dilihat kembali setelah garansi berakhir. Admin: Toko → Produk Lainnya → Klaim Garansi. Jawaban atau data penggantian dimasukkan oleh admin; bot mengirimnya melalui DM. Fitur ini tidak mengambil stok penggantian dan tidak melakukan refund otomatis.
- Produk habis: detail produk → Notifikasi Stok. Maksimal 20 notifikasi aktif per pembeli. Pemberitahuan satu kali dikirim bila stok jual dan data otomatis tersedia; tidak memesan atau mengurangi stok. Tombol yang sama mematikan notifikasi selama produk belum tersedia.
- Notifikasi diproses tiap menit, maksimum 10 per kategori per putaran, dengan percobaan ulang jika DM gagal. Tetap ada kemungkinan pesan berulang bila bot berhenti tepat setelah mengirim DM sebelum mencatat keberhasilan. Pembeli harus mengaktifkan izin DM.
- Semua data disimpan di SQLite yang sama pada volume Railway. Tidak perlu dependency baru atau file database baru.

Pembaruan ini: ganti **index.js, admin.js, manual-products.js, order-history.js**, dan tambahkan **premium-products.js**. Tes baru tersedia di premium-products.test.js. Jangan menghapus database atau volume.

## Menu produk admin yang disederhanakan

Detail produk hanya mempunyai tiga kategori: **Ubah Produk** (nama, deskripsi, harga), **Data & Stok** (data kirim, stok jual, pratinjau), dan **Pengaturan** (aktif/nonaktif, kirim otomatis, varian/panduan/garansi, tes beli, hapus). Setiap tindakan mempunyai satu tempat pada menu; Kembali menuju detail produk dan Menu Awal Admin menuju panel admin. Tombol pada pesan lama tetap dikenali. Untuk perubahan menu ini cukup ganti manual-products.js dan premium-products.js; index.js versi produk premium tetap diperlukan.

## Pemeriksaan kerapian menu terbaru

Pembayaran kini mempunyai tiga kategori: **Pesanan & Verifikasi** (pesanan produk, pengajuan saldo manual), **Pemeriksaan** (pembayaran bermasalah, topup tertunda), **Riwayat & Petunjuk** (riwayat isi saldo, QRIS beli, petunjuk manual). Setiap tindakan muncul pada satu kategori. Tombol lama tetap dapat diproses. Daftar akun pembeli dan pilihan klaim berwarna abu-abu setelah navigasi diterapkan. Kembali pada detail varian menuju daftar varian. Pengujian lokal tidak memastikan bot Railway sudah memakai versi ini.

Untuk pembaruan pemeriksaan menu ini ganti **admin.js, navigation.js, manual-products.js**. Jika versi produk premium belum terpasang, sertakan pula index.js, order-history.js dan premium-products.js versi terbaru.


Peningkatan panel admin: Kelola Produk → Cari Produk mencari nama produk dan varian, dengan halaman hasil privat. Klaim Garansi mempunyai filter Menunggu, Selesai, Ditolak dan Semua. Jumlah antrean tampil pada tombol terkait saat panel dibuka kembali; angka nol disembunyikan.

Command `/ping` khusus admin terdaftar menampilkan heartbeat Discord, waktu respons awal, waktu akses database, RAM dan waktu berjalan. Hasil privat, tanpa permintaan ke provider atau perubahan saldo. Menu Awal dari ping menuju panel admin. Command didaftarkan ulang saat bot berjalan memakai Application ID dari token bot. DISCORD_CLIENT_ID kosong atau berbeda tidak lagi menyebabkan pendaftaran dilewati. Log keberhasilan: `Command Discord berhasil didaftarkan: /shop, /admin, /ping`. Kegagalan dicatat dengan kode error tanpa token.


Navigasi lanjutan: daftar pesanan produk dan pengajuan saldo manual kembali ke Pesanan & Verifikasi; pemeriksaan bermasalah dan cek topup kembali ke Pemeriksaan; riwayat QRIS kembali ke Riwayat & Petunjuk; backup kembali ke Data & Pemeliharaan. Petunjuk riwayat pesanan mengikuti menu pembeli yang sudah disatukan. Tidak ada perubahan saldo, stok atau transaksi pada pembaruan navigasi ini.


## Bahasa Indonesia dan English

Buka /shop → Bahasa / Language, atau /admin → Bahasa / Language. Pilih Bahasa Indonesia atau English. Pilihan disimpan per ID Discord pada tabel bot_languages dalam database yang sama, berlaku setelah restart/redeploy apabila DB_PATH berada di volume. Default Bahasa Indonesia. Pilihan akun lain tetap terpisah. Tidak diperlukan API penerjemah, dependency baru, token, atau konversi mata uang.

English mencakup menu utama toko/admin, tombol navigasi dan tindakan umum, panduan belanja, pilihan filter, formulir yang dikenali serta sejumlah label/pesan pembayaran. Terjemahan lokal memakai daftar teks; teks sistem yang belum mempunyai padanan tetap dalam Bahasa Indonesia. Nama produk/varian/provider, deskripsi admin, nilai formulir, harga, ID, OTP, akun/kode, balasan tiket/klaim dan isi data pengiriman tidak diterjemahkan. Pesan panjang/detail yang memuat data bebas sengaja mempertahankan teks aslinya. Tombol dalam DM produk mengikuti pilihan bahasa, sedangkan isi data produk tetap asli. Tidak semua pesan DM atau pesan provider diterjemahkan.

Pilihan bahasa bersifat privat dan tetap mengikuti pembatasan server/channel/role serta akses DM admin. Tidak ada command baru untuk bahasa; /shop, /admin dan /ping tetap tersedia. Pembaruan bahasa: ganti index.js dan admin.js; tambahkan languages.js. Database memperbarui tabel secara otomatis tanpa menghapus saldo atau stok.


### Pilih bahasa sebelum mulai belanja

Pengguna yang belum mempunyai pilihan bahasa mendapat layar Bahasa Indonesia / English saat membuka /shop atau mencoba tombol pembelian lama. Keduanya bisa dipilih, termasuk default Indonesia. Setelah memilih, menu toko langsung dibuka secara privat dalam bahasa tersebut. Pengguna yang sudah memilih tidak ditanya ulang saat /shop berikutnya atau setelah restart. Pilihan dapat diubah kembali melalui Bahasa / Language. Pembatasan server/channel/role tetap diperiksa sebelum layar bahasa. Pembaruan onboarding: ganti index.js dan languages.js.


## Pembaruan panel, pengiriman, laporan dan pencarian

### Panel toko permanen

Buka `/admin → Sistem → Akses Bot → Panel Toko` **dari channel teks toko pada server tujuan**. Tekan **Pasang / Perbarui Panel**. Server harus disetujui; jika channel transaksi sudah dikunci, pemasangan hanya pada channel itu. Bot memerlukan izin Lihat Channel, Kirim Pesan dan Sematkan Tautan. Satu panel per server disimpan dalam database: menekan tombol lagi memperbarui pesan yang sama. Untuk pindah channel, hapus panel lama dahulu. Pembeli menekan **Mulai Belanja / Start Shopping**, memilih bahasa, lalu mendapat menu belanja privat tanpa mengetik `/shop`. Izin server/channel/role tetap berlaku. Panel tidak memuat saldo pribadi. `/shop` tetap tersedia.

### DM gagal

Buka `/admin → Pembayaran → Pemeriksaan → DM Gagal`. Daftar mencakup hasil/refund produk digital dan OTP yang gagal dikirim sejak pembaruan, menampilkan ID pesanan, pembeli, jumlah percobaan dan diagnosis aman. Tidak menyimpan salinan akun, OTP, token, atau pesan error mentah. Pengiriman otomatis yang sudah ada tetap mencoba ulang; **Coba Ulang** memakai pesanan dan penerima asli, tidak membuat pembelian atau memotong saldo/stok kembali. Percobaan manual dibatasi 30 detik per pesanan. Pesanan yang sudah berhasil dikirim tidak dapat dikirim ulang melalui antrean ini. Jika DM tertutup, pembeli perlu mengaktifkan DM dari anggota server; hasil pesanan juga tersedia privat pada riwayatnya. Notifikasi bantuan/promosi tidak masuk antrean pesanan ini.

### Laporan gabungan

`/admin → Laporan → Hari Ini / Bulan Ini` dan Ekspor CSV kini mencakup OTP serta produk digital, masing-masing dengan jumlah pesanan dan penjualan net. Produk digital sudah dibayar (menunggu admin, selesai atau refund) dihitung satu kali; invoice belum dibayar/kedaluwarsa tidak menjadi pendapatan. Transaksi tes owner tetap dikecualikan. Periode memakai WIB berdasarkan tanggal pembuatan pesanan; biaya gateway memakai tanggal pembayaran. Modal produk yang diketahui sekarang dikurangi dari selisih. Pesanan dengan modal belum diisi ditandai terpisah; hosting dan biaya lain belum termasuk, sehingga angka belum merupakan laba bersih akuntansi. Saldo topup tidak dihitung sebagai penjualan lagi.

### Cari pesanan

`Pesanan → Riwayat Pesanan / Invoice / Riwayat OTP → Cari Pesanan`. Isi invoice/bukti transaksi, nama produk, dan/atau tanggal **YYYY-MM-DD (WIB)**. Beberapa kolom berarti semua kriteria harus cocok. Pencarian hanya mengembalikan pesanan pemilik yang sedang memakai bot, mempertahankan kategori OTP jika dipilih, dan tidak menggandakan invoice OTP yang sudah menjadi pesanan. Hasil lima per halaman, sesi berlaku 15 menit. Menu pesanan admin tetap pada kategorinya.

### English transaksi

Konfirmasi dan status produk digital, rincian QRIS, detail invoice/riwayat pesanan, notifikasi hasil produk serta OTP sekarang mempunyai label English sesuai bahasa penerima. Produk, deskripsi/panduan admin, akun/kode, nomor, OTP, harga IDR dan pesan provider tetap asli. Teks sistem lain yang belum mempunyai padanan tetap Indonesia. Pilihan bahasa tetap tersimpan per pengguna; tombol Bahasa / Language bisa menggantinya kembali.

### File pembaruan ini

Ganti **8 file runtime**: `index.js`, `admin.js`, `languages.js`, `manual-products.js`, `direct-payments.js`, `operations.js`, `order-history.js`, `shop-tools.js`. Tambahkan **1 file runtime baru**: `shop-improvements.js`. Total **9 file kode** untuk pembaruan ini; README.md dan CARA_PASANG.txt hanya dokumentasi. Tidak ada dependency atau variable baru. Tabel panel/diagnostik dibuat otomatis di database yang sama. Jangan menghapus database atau volume Railway. Paket lengkap mempertahankan modul pembaruan sebelumnya.


## Keandalan toko dan modal produk — pembaruan terbaru

**File kode:** ganti `index.js`, `admin.js`, `languages.js`, `manual-products.js`, `shop-tools.js`; tambahkan `shop-health.js`. Total **6 file kode** untuk pembaruan ini. Tidak ada dependency atau variable baru. Paket lengkap mencakup semua pembaruan sebelumnya.

### Kesiapan toko

`/admin → Sistem → Data & Pemeliharaan → Kesiapan Toko` menampilkan database, status konfigurasi QRIS (produksi/sandbox), konfigurasi API/webhook SMSCode, izin lihat/kirim/embed pada channel toko, jumlah produk otomatis yang kekurangan stok/data, hasil tes backup yang terakhir dan jumlah ketidakcocokan catatan transaksi. Tidak melakukan pembelian atau menampilkan token/saldo provider. Status konfigurasi tersedia **bukan bukti koneksi berhasil**. Gunakan tombol tes webhook yang sudah ada dan **Tes DM Admin** untuk pemeriksaan langsung; hasil tes DM admin tidak menjamin semua pembeli membuka DM.

### Pesanan terlambat

`/admin → Pembayaran → Pemeriksaan → Pesanan Terlambat`. Default batas **15 menit**, dapat diatur **5–1440 menit**; peringatan bisa dimatikan. Pemeriksaan tiap menit: produk dibayar yang menunggu admin, hasil/refund produk yang belum terkirim ke DM, QRIS produk lunas yang belum diproses, dan pembayaran OTP yang sedang diproses/perlu tinjauan. Tidak menandai OTP aktif yang sedang menunggu SMS sebagai pesanan gagal. Setiap alasan/pesanan diberi tahu satu kali per admin, tetap tersimpan setelah restart. Jika DM admin gagal, dicoba kembali pada pemeriksaan berikutnya. Maksimal lima notifikasi per admin per batch. Daftar hilang dari keterlambatan setelah kondisinya selesai, tanpa menghapus riwayat. Peringatan tidak mengurangi saldo, melakukan refund atau memesan ulang. Sesuaikan batas dengan waktu pengerjaan produk manual.

### Cocokkan transaksi

`/admin → Pembayaran → Pemeriksaan → Cocokkan Transaksi` memeriksa saldo negatif; pesanan QRIS produk/OTP dengan invoice, penerima, nominal atau tujuan tidak cocok; tagihan pembelian terverifikasi tanpa pesanan; status lunas yang belum ditandai terverifikasi; pesanan produk lunas yang masih menunggu pembayaran; OTP berhasil tanpa catatan order yang cocok; serta data terjual tanpa pesanan selesai. Daftar hanya menampilkan referensi dan alasan, tanpa akun/kode/OTP. Pemeriksaan **membaca database lokal** dan tidak mengubah uang/status/data. Ini bukan konfirmasi langsung gateway atau rekonstruksi seluruh ledger saldo. Tinjau mutasi dan data provider sebelum tindakan melalui menu pemeriksaan yang sudah ada; tidak ada tombol koreksi saldo/refund massal otomatis.

### Tes pemulihan backup

Owner membuka `/admin → Sistem → Data & Pemeliharaan → Backup → Tes Pemulihan`. Buat **Backup Sekarang** bila belum ada salinan. Tes menyalin backup terakhir ke folder sementara, membukanya terpisah, menjalankan `PRAGMA integrity_check`, memeriksa lima tabel utama dan menghitung baris. Salinan sementara dihapus setelah tes. **Database aktif tidak diganti**, saldo/data pembeli tetap sama. Batas ukuran tes 64 MB. Ini menguji pemulihan salinan, bukan memulihkan server/gateway/configuration; tetap simpan unduhan backup di tempat terpisah dari volume. Hasil tes mencatat salinan yang diuji; backup baru memerlukan tes baru.

### Modal dan keuntungan

`/admin → Toko → Produk Lainnya → Kelola Produk → pilih produk/varian → Ubah Produk → Harga & Modal`. Modal per unit 0–1.000.000 IDR tanpa titik. Kosong berarti **belum diketahui**, sedangkan `0` berarti modal nol yang memang dicatat. Modal tidak terlihat pada menu pembeli, konfirmasi, invoice atau DM produk. Form tambah produk tetap ringkas: modal dapat diisi melalui Ubah Produk sesudah membuat produk.

Konfirmasi pembelian menyimpan modal sebagai snapshot dan pesanan baru memakai nilai snapshot itu (saldo maupun QRIS). Mengubah modal produk berikutnya tidak mengubah pesanan lama; pesanan sebelum fitur ini tetap berstatus modal belum diketahui. Laporan harian/bulanan dan CSV mengurangi modal pesanan produk yang dibayar dan tidak direfund. Modal pesanan direfund tidak dikurangi. Tampilan **keuntungan sementara** mengurangi biaya provider OTP, biaya gateway tercatat dan modal produk yang diketahui; jumlah modal/biaya belum diketahui tetap ditampilkan. Hosting, pajak, pengeluaran lain serta kerugian modal yang tidak pulih setelah refund belum termasuk. Bukan laba bersih akuntansi.

**Validasi rilis:** 259 tes lokal lulus. Belum diuji pada akun Discord, Railway, SMSCode atau gateway milik pengguna. Setelah deployment, buka panel baru untuk melihat submenu terbaru.

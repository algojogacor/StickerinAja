# 🤝 Panduan Kontribusi (Contributing Guidelines)

Terima kasih telah tertarik untuk berkontribusi pada proyek **Stickerin Bot**! Kontribusi dari komunitas adalah apa yang membuat proyek open source menjadi luar biasa.

Berikut adalah beberapa panduan yang perlu diikuti agar proses kontribusi berjalan dengan lancar dan rapi.

---

## 🐛 Cara Melaporkan Masalah (Bug Reports)

Jika Anda menemukan masalah atau error saat menggunakan bot:
1.  **Cari di Tab Issues**: Pastikan masalah yang Anda temui belum pernah dilaporkan oleh orang lain sebelumnya.
2.  **Buat Issue Baru**: Jika belum ada, buat issue baru dengan menyertakan informasi berikut:
    *   Deskripsi singkat mengenai bug tersebut.
    *   Langkah-langkah untuk mereproduksi bug.
    *   Pesan error atau log dari terminal (jika ada).
    *   Versi Node.js dan sistem operasi yang Anda gunakan.

---

##💡 Mengusulkan Fitur Baru (Feature Requests)

Kami sangat terbuka dengan ide-ide baru! Untuk mengusulkan fitur baru:
1.  Buka tab **Issues** dan pilih template **Feature Request** (atau buat issue biasa jika template tidak tersedia).
2.  Jelaskan secara detail fitur apa yang ingin Anda tambahkan dan mengapa fitur tersebut berguna bagi pengguna bot ini.

---

## 🛠️ Alur Kontribusi Kode (Pull Requests)

Jika Anda ingin memperbaiki bug atau menambahkan fitur baru secara langsung melalui kode, silakan ikuti alur berikut:

1.  **Fork Repositori**: Buat salinan repositori ini ke akun GitHub Anda.
2.  **Clone Hasil Fork**: Clone repositori hasil fork Anda ke perangkat lokal.
    ```bash
    git clone https://github.com/username/stickerin-bot.git
    ```
3.  **Buat Branch Baru**: Buat branch baru khusus untuk perubahan Anda. Gunakan penamaan branch yang deskriptif.
    ```bash
    git checkout -b feature/nama-fitur-baru
    # atau
    git checkout -b fix/nama-bug-yang-diperbaiki
    ```
4.  **Lakukan Perubahan Kode**:
    *   Pastikan kode Anda rapi dan mudah dibaca.
    *   **PENTING**: Patuhi arsitektur performa hemat memori yang sudah dibangun (misalnya menggunakan antrean antarmuka/ffmpeg jika memproses media berukuran besar, dan melepaskan buffer memori yang sudah tidak dipakai agar bot ramah RAM 512MB).
5.  **Commit Perubahan**: Tulis pesan commit yang jelas dan deskriptif.
    ```bash
    git commit -m "feat: menambah dukungan format stiker lingkaran dinamis"
    ```
6.  **Push Perubahan**: Push branch Anda ke repositori GitHub hasil fork Anda.
    ```bash
    git push origin feature/nama-fitur-baru
    ```
7.  **Buat Pull Request (PR)**:
    *   Buka repositori asli kami di GitHub.
    *   Klik tombol **Compare & pull request**.
    *   Jelaskan perubahan apa yang Anda lakukan dalam deskripsi PR Anda.
    *   Tunggu ulasan (review) dari kami.

---

## 📝 Aturan Penulisan Kode (Code Style)

*   Gunakan JavaScript modern (ES6+) yang didukung secara bawaan oleh Node.js v20.
*   Gunakan indentasi **4 spasi** (atau sesuaikan dengan konfigurasi `.editorconfig` jika ada).
*   Gunakan metode pemrograman asinkron (`async/await` dan `fs.promises`) daripada metode sinkron untuk operasi pembacaan file atau proses yang memakan waktu lama agar server WhatsApp Baileys tidak mengalami hang/lag.
*   Selalu tambahkan penanganan kesalahan (*error handling*) yang kuat menggunakan blok `try...catch`.

Sekali lagi, terima kasih atas kontribusi Anda! Selamat bersenang-senang dengan kode Anda! 🚀

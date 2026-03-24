# ⚡ Hot-Swapper

> **Chuyển đổi nhanh tài khoản profile** — Chrome Extension (Manifest V3)

Bạn quản lý nhiều tài khoản Facebook, Chợ Tốt, hay bất kỳ trang nào? Hot-Swapper giúp bạn **lưu trữ & chuyển đổi phiên đăng nhập** chỉ trong 1 click — không cần logout, không bị OTP, không bị checkpoint.

---

## 🎯 Vấn đề

| 😰 Trước đây                           | ⚡ Với Hot-Swapper                                   |
| -------------------------------------- | ---------------------------------------------------- |
| Logout → Login → Nhập OTP → Chờ verify | **1 click** chuyển tài khoản                         |
| Facebook checkpoint khi đổi account    | Bypass hoàn toàn — nuke fingerprint trước khi inject |
| Mỗi trang phải xử lý khác nhau         | Hỗ trợ **mọi trang web** tự động                     |
| Dữ liệu mất khi xóa browser            | Export/Import backup dễ dàng                         |

---

## ✨ Tính năng

### 🔄 Chuyển đổi tức thì

- Lưu toàn bộ phiên (cookies + localStorage + sessionStorage)
- Chuyển tài khoản chỉ **1 click** — không reload thủ công
- Cross-site swap: đang ở Facebook → bấm dùng nick Chợ Tốt → tự chuyển

### 🌳 Giao diện Tree

- Nhóm tài khoản theo trang web (Facebook, Chợ Tốt, ...)
- Tự động nhận diện tài khoản đang active (xanh lá)
- Badge cảnh báo khi session cũ/hết hạn

### 🔐 Bypass bảo mật

- **Nuke toàn bộ** IndexedDB, Service Workers, Cache trước khi inject
- Facebook không phát hiện session cũ → không checkpoint
- Chợ Tốt không yêu cầu OTP lại

### 📦 Export / Import

- Xuất tất cả tài khoản ra file JSON
- Nhập & **Smart Merge**: trùng tên → giữ bản mới hơn
- Chuyển dữ liệu giữa các máy dễ dàng

### 🧠 Cookie Fingerprint Matching

- Tự động nhận diện tài khoản đang đăng nhập
- Facebook: detect qua cookie `c_user`
- Chợ Tốt: scan JWT trong cookies
- Trang generic: so khớp session cookies (≥50% match = active)

---

## 🏗️ Kiến trúc

```
┌─────────────────────────────────────────────┐
│                 POPUP UI                     │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐ │
│  │ 💾 Lưu  │  │ ➕ Thêm  │  │ 📤📥 Backup│ │
│  └────┬────┘  └────┬─────┘  └────────────┘ │
│       │             │                        │
│  ┌────▼─────────────▼───────────────────┐   │
│  │         chrome.storage.local          │   │
│  │  session_facebook.com_abc123 = {...}  │   │
│  │  session_chotot.com_def456   = {...}  │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

### Luồng 3 bước (Async/Await)

```
 ┌──────────┐     ┌──────────┐     ┌──────────┐
 │ EXTRACT  │────▶│   NUKE   │────▶│  INJECT  │
 │          │     │          │     │          │
 │ Cookies  │     │ Cookies  │     │ Cookies  │
 │ Local    │     │ IndexedDB│     │ Local    │
 │ Session  │     │ SW/Cache │     │ Session  │
 │ Storage  │     │ Storage  │     │ Storage  │
 └──────────┘     └──────────┘     └──────────┘
```

**1. Extract** — Lấy toàn bộ dữ liệu phiên đăng nhập

```
cookies (chrome.cookies.getAll)
+ localStorage (chrome.scripting.executeScript)
+ sessionStorage
→ Lưu vào chrome.storage.local
```

**2. Nuke** — Xóa sạch dấu vết trên tất cả origins liên quan

```
chrome.browsingData.remove({
  cookies, localStorage, indexedDB,
  serviceWorkers, cacheStorage
})
```

**3. Inject** — Bơm lại session của tài khoản đích

```
chrome.cookies.set (từng cookie một)
+ chrome.scripting.executeScript (localStorage/sessionStorage)
→ Reload trang → Đăng nhập tự động
```

---

## 📥 Cài đặt

### Từ Release (khuyên dùng)

1. Vào [Releases](../../releases) → tải file `.zip` mới nhất
2. Giải nén ra thư mục
3. Mở `chrome://extensions`
4. Bật **Developer mode** (góc phải trên)
5. Bấm **Load unpacked** → chọn thư mục vừa giải nén

### Từ source code

```bash
git clone https://github.com/azoom-pham-the-tho/hot-swapper.git
# Mở chrome://extensions → Load unpacked → chọn thư mục hot-swapper
```

---

## 🎮 Cách sử dụng

### Lưu tài khoản

1. Đăng nhập trang web bình thường
2. Bấm icon Hot-Swapper ⚡
3. Nhập tên nick (VD: "Tho FB chính")
4. Bấm **💾 Lưu**

### Thêm tài khoản mới

1. Bấm **➕ Thêm mới** → Extension tự lưu session hiện tại, dọn sạch, reload
2. Đăng nhập tài khoản mới
3. Nhập tên → **💾 Lưu**

### Chuyển đổi

- Bấm **▶ Dùng** trên bất kỳ nick nào → chuyển tức thì!
- Cross-site: đang ở Facebook bấm nick Chợ Tốt → tự navigate + inject

### Backup / Restore

- **📤 Xuất** → tải file JSON chứa tất cả tài khoản
- **📥 Nhập** → chọn file JSON → smart merge (giữ bản mới hơn)

---

## 🔧 Quyền sử dụng

| Quyền          | Lý do                                        |
| -------------- | -------------------------------------------- |
| `cookies`      | Đọc/ghi cookies để lưu trữ & inject session  |
| `storage`      | Lưu profiles vào chrome.storage.local        |
| `activeTab`    | Truy cập tab hiện tại                        |
| `tabs`         | Điều hướng tab cho cross-site swap           |
| `scripting`    | Inject localStorage/sessionStorage vào trang |
| `browsingData` | Nuke dữ liệu khi chuyển tài khoản            |

---

## 📂 Cấu trúc

```
hot-swapper/
├── manifest.json       # Cấu hình Chrome Extension (MV3)
├── popup.html          # Giao diện popup (CSS inline)
├── popup.js            # Logic chính (~1000 dòng)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── .github/
    └── workflows/
        └── release.yml # CI/CD: auto release khi push tag
```

---

## 🚀 Release quy trình

```bash
# Sửa version trong manifest.json
# Commit & push
git add -A && git commit -m "v1.1.0 - mô tả thay đổi"
git tag v1.1.0
git push origin main --tags
# → GitHub Actions tự tạo Release + file zip
```

---

## 📄 License

MIT — Sử dụng tự do cho mục đích cá nhân.

---

<p align="center">
  <b>⚡ Hot-Swapper</b> — Built for speed, designed for convenience
</p>

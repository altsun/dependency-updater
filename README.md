# Dependency Updater

Static web app chạy trên GitHub Pages: quét toàn bộ repo trong tài khoản GitHub của bạn, tìm
thư viện đã có bản mới, và mở pull request nâng cấp — tất cả chạy trong trình duyệt, **không có
backend**.

## Cách hoạt động

1. Bạn dán fine-grained personal access token (lưu trong `localStorage`, chỉ gửi tới `api.github.com`).
2. App gọi `GET /user/repos` để lấy danh sách repo, rồi với mỗi repo lấy cây file
   (`git/trees?recursive=1`) để tìm manifest.
3. Với mỗi manifest, đọc nội dung và tra phiên bản mới nhất từ registry
   (`registry.npmjs.org`, `pypi.org` — cả hai đều bật CORS nên gọi trực tiếp được).
4. Bạn tick chọn những gói muốn nâng, app tạo branch → commit file đã sửa → mở PR.

## Hệ sinh thái được hỗ trợ

| Manifest | Registry | Ghi chú |
| --- | --- | --- |
| `package.json` | npm | `dependencies`, `devDependencies`, `optionalDependencies`. Giữ nguyên toán tử range (`^1.2.3` → `^1.9.0`). |
| `requirements*.txt` | PyPI | Chỉ sửa dòng ghim cứng `==`; giữ nguyên comment và environment marker. |

Bỏ qua an toàn: `peerDependencies`, `*`, `latest`, `workspace:`, `file:`, git URL, range phức tạp
(`>=1 <2`, `1.x`), và mọi thứ nằm trong `node_modules/`, `vendor/`, `dist/`…

## Chạy local

```bash
python -m http.server 8080
# mở http://localhost:8080
```

Phải chạy qua HTTP server (ES modules không load được từ `file://`).

## Deploy lên GitHub Pages

1. Push repo này lên GitHub.
2. **Settings → Pages → Source: GitHub Actions**.
3. Workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) sẽ tự deploy mỗi lần push vào `main`.

## Token cần quyền gì

Tạo tại <https://github.com/settings/personal-access-tokens/new>, chọn đúng các repo cần thiết:

- **Contents**: Read and write (tạo branch + commit)
- **Pull requests**: Read and write (mở PR)
- **Metadata**: Read-only (bắt buộc)

Không cần quyền nào khác. Nếu chỉ muốn xem kết quả quét mà không tạo PR, token read-only là đủ.

## Giới hạn cần biết

- **Không regenerate lockfile.** `package-lock.json` / `yarn.lock` / `poetry.lock` không được cập
  nhật, vì việc đó cần chạy package manager thật. Chạy `npm install` trước khi merge PR.
- **Rate limit** 5.000 request/giờ cho token. Mỗi repo tốn ~2 + số manifest request. Dùng ô
  "Giới hạn số repo quét" nếu tài khoản có nhiều repo.
- Repo quá lớn có thể trả về cây file bị cắt (`truncated`) — app sẽ ghi cảnh báo vào nhật ký.
- Bỏ qua phiên bản prerelease (alpha/beta/rc) khi chọn bản mới nhất.
- Token nằm trong `localStorage` của trình duyệt — tránh dùng trên máy dùng chung, và revoke
  token khi không cần nữa.

## Test

```bash
node test/smoke.mjs
```

Kiểm tra phần logic thuần (so sánh semver, parse & rewrite manifest) — không cần mạng.

## Có sẵn giải pháp khác

GitHub đã có [Dependabot](https://docs.github.com/code-security/dependabot) miễn phí và
[Renovate](https://docs.renovatebot.com/), chạy server-side, có regenerate lockfile và theo dõi
security advisory. Tool này hữu ích khi bạn muốn **chủ động quét một lượt toàn bộ tài khoản và
chọn tay từng gói**, thay vì cấu hình `dependabot.yml` trong từng repo.

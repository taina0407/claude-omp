[English](README.md) | **Tiếng Việt**

# omp

[![CI](https://github.com/taina0407/claude-omp/actions/workflows/ci.yml/badge.svg)](https://github.com/taina0407/claude-omp/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/taina0407/claude-omp)](https://github.com/taina0407/claude-omp/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Plugin cho Claude Code, trong đó Claude đảm nhiệm **điều phối** và
[omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) đảm nhiệm **thực thi**. Claude xác định
phạm vi tác vụ, chọn mô hình và giám sát việc thực thi qua `omp-task`. Một daemon (tiến trình
nền) riêng cho mỗi người dùng quản lý các job (đơn vị công việc) và chỉ đánh thức
Claude khi có câu hỏi, yêu cầu phê duyệt, checkpoint (mốc kiểm tra), tình trạng ngừng tiến
triển hoặc khi hoàn tất — không phải khi có cập nhật tiến độ thông thường. Claude kiểm tra
kết quả, tích hợp thay đổi từ worktree (cây làm việc Git riêng biệt) khi dùng chế độ tách biệt
và có thể yêu cầu thực hiện thêm một vòng. Kho mã có tên `claude-omp`; plugin được cài đặt là
`omp@omp-tools`; chương trình thực thi là `omp`.

```text
You → Claude ── brief / answers / approvals ──→ omp-task
       ↑                                         │ Unix socket
       │                                     per-user daemon
       └── attention or completion ←─────────────┤
                                                 └── RPC → omp worker
                                                      chosen model
```

[Bắt đầu nhanh](#bắt-đầu-nhanh) · [Lệnh](#các-lệnh-trong-claude-code) ·
[CLI (giao diện dòng lệnh)](#tham-chiếu-cli) · [An toàn](#quyền-truy-cập-tách-biệt-và-quy-tắc-phê-duyệt) ·
[Xử lý sự cố](#xử-lý-sự-cố-và-câu-hỏi-thường-gặp)

## Điểm nổi bật

- **Giám sát theo sự kiện cần xử lý.** Lệnh chờ chạy nền trả về khi Claude cần hành động hoặc
  khi các job hoàn tất. Quy tắc phê duyệt xử lý các lệnh đã biết mà không cần thêm lượt hội thoại.
- **Quyền truy cập và tách biệt.** Chọn quyền đọc, chỉnh sửa hoặc toàn quyền; dùng Git worktree
  để kiểm tra, áp dụng hoặc loại bỏ thay đổi riêng biệt với bản checkout hiện tại.
- **Thực thi song song.** Nhóm, quan hệ phụ thuộc, truyền kết quả, giới hạn số job chạy đồng
  thời và ngân sách chi tiêu giúp phối hợp các job độc lập hoặc có thứ tự.
- **Kiểm tra có cấu trúc.** Mô hình kiểm tra thông thường và mô hình kiểm tra đối kháng trả về
  các phát hiện đã được kiểm tra tính hợp lệ. Có thể bật hook (điểm móc tự động) Stop để kiểm
  tra thay đổi trước khi Claude kết thúc một lượt.
- **Lưu giữ job.** Xem kết quả đã lưu, tiếp tục job bị gián đoạn hoặc tiếp tục phiên omp của
  một job đã hoàn tất với phản hồi cụ thể.

## Bắt đầu nhanh

### Yêu cầu

- [Claude Code](https://code.claude.com) **2.1.91+** để hỗ trợ `bin/` của plugin trên PATH
  của công cụ Bash.
- [Bun](https://bun.sh) **1.3+**, hoặc tệp nhị phân phát hành phù hợp cho `omp-task`. Bản omp
  gốc vẫn cần được cài đặt riêng và hoạt động bình thường.
- Có `omp` **18.12+** trên PATH và đã xác thực với nhà cung cấp. Làm theo
  [hướng dẫn thiết lập của dự án gốc](https://github.com/can1357/oh-my-pi), dùng `omp login`
  và xem `omp models`.
- Git để kiểm tra mã, phát hiện tệp thay đổi và dùng worktree. Worktree yêu cầu kho mã có ít
  nhất một commit (bản ghi thay đổi trong Git).

Các bản phát hành hỗ trợ Linux và macOS trên x64 và arm64; không có bản nhị phân Windows gốc.

### Cài đặt plugin

Chạy các lệnh sau trong terminal:

```bash
claude plugin marketplace add taina0407/claude-omp
```

```bash
claude plugin install omp@omp-tools
```

Trong phiên Claude Code đang mở, tải lại plugin:

```text
/reload-plugins
```

Sau đó chạy thiết lập:

```text
/omp:setup
```

Trình khởi chạy từ mã nguồn cài các phụ thuộc lúc chạy trong lần sử dụng đầu tiên. Nếu chưa
có, bước thiết lập tạo `~/.config/claude-omp/config.json` từ
[config.example.json](config.example.json); tệp hiện có được giữ nguyên và thông tin chẩn
đoán được in ra. Xác nhận đã tìm thấy omp và tệp cấu hình tồn tại.
`daemon: not running (starts on demand)` là trạng thái bình thường. Các chẩn đoán này không
kiểm tra việc xác thực với nhà cung cấp.

### Giao tác vụ đầu tiên

Khi đã đáp ứng các yêu cầu, mục tiêu là khởi chạy job đầu tiên này trong chưa đầy năm phút.
Thời gian mô hình hoàn tất phụ thuộc vào nhà cung cấp. Từ bản checkout này, yêu cầu Claude:

```text
/omp:delegate Use the default model with read-only access to explain how
src/core/policy.ts resolves allow and deny rules. Include the tool: exception.
Do not change files.
```

**Hội thoại minh họa — không phải bản ghi của một lần chạy thực tế:**

```text
Claude: Tôi sẽ khởi chạy một job chỉ đọc với phạm vi giới hạn và chờ ở chế độ nền.
        [Job hoàn tất và lệnh chờ chạy nền trả về.]
Claude: Quy tắc từ chối được ưu tiên. Quy tắc cho phép theo mẫu lệnh từ chối
        pipe và chuyển hướng; quy tắc cho phép toàn bộ công cụ bỏ qua bước
        kiểm tra đó. Không có tệp nào thay đổi.
        Báo cáo gồm mô hình thực tế được chọn, chi phí đã ghi nhận và các bước tôi đã kiểm tra.
```

Tên mô hình và chi phí thực tế lấy từ siêu dữ liệu của job, không phải ví dụ minh họa này.
Với kho mã khác, thay bằng một tệp nhỏ hoặc câu hỏi phù hợp. `/omp:status` hiển thị các job;
khi bên thực thi đặt câu hỏi hoặc cần phê duyệt, Claude xử lý mục đó rồi tiếp tục chờ.

### Các cách cài đặt khác

Từ một bản checkout, cài plugin và tạo liên kết CLI trong `~/.local/bin`:

```bash
./install.sh
```

Hoặc chỉ cài CLI, các phụ thuộc và cấu hình người dùng:

```bash
./install.sh --cli
```

Các cách cài đặt này yêu cầu Bun. Cài plugin giúp công cụ Bash của Claude gọi được `omp-task`;
không thêm lệnh này vào PATH của terminal thông thường. Trình cài đặt từ checkout tạo liên
kết đó; bảo đảm `~/.local/bin` có trên PATH.

Để dùng tệp nhị phân phát hành thay cho môi trường chạy mã nguồn Bun, chạy lệnh sau qua công
cụ Bash của Claude hoặc trong terminal có sẵn trình khởi chạy:

```bash
omp-task install-binary
```

Trình khởi chạy tải tệp nhị phân cùng phiên bản với nó, xác minh SHA-256 bằng `SHA256SUMS`,
rồi ưu tiên dùng tệp đó. Cài tệp nhị phân cần `curl` và `sha256sum` hoặc `shasum`.

## Khi nào nên dùng

### Tác vụ phù hợp — và khi nào nên giữ tác vụ trong Claude

Giao các tác vụ độc lập, có ranh giới chỉnh sửa rõ ràng và kết quả dễ kiểm tra hơn thực hiện:
tái cấu trúc cơ học, tính năng có phạm vi giới hạn, nghiên cứu hoặc kiểm tra mã bằng một mô
hình khác. Các tác vụ độc lập có thể chạy song song khi thay đổi của chúng không chồng lấn.

Giữ lại trong phiên hiện tại các chỉnh sửa một dòng, quyết định phụ thuộc vào hội thoại và
các tệp Claude đang chỉnh sửa. Việc giao tác vụ phát sinh thêm công sức soạn brief (bản giao
nhiệm vụ) và kiểm tra kết quả, cùng chi phí sử dụng nhà cung cấp của bên thực thi; chọn mô
hình khác không bảo đảm tổng chi phí thấp hơn. Claude vẫn chịu trách nhiệm kiểm tra diff
(bản so sánh thay đổi) thực tế và chạy lệnh nghiệm thu trong brief trước khi báo thành công.

### So với chạy omp trực tiếp

| Cách làm | Chọn khi |
|---|---|
| Chỉ dùng Claude | Tác vụ phụ thuộc vào hội thoại hiện tại hoặc không cần bên thực thi riêng. |
| Chạy omp trực tiếp | Muốn tự tương tác với bên thực thi. |
| Plugin này | Claude cần phụ trách brief, trả lời, kiểm tra và tích hợp, còn omp thực thi. |
| `/omp:transfer` | Muốn tiếp tục nội dung hội thoại trong omp tương tác. |

Lệnh chuyển tiếp in ra `omp --from-claude` để chạy trong terminal và chọn phiên.
Đây không phải chuyển giao tự động; các tin nhắn Claude sau đó vẫn ở trong Claude.

## Các lệnh trong Claude Code

Yêu cầu bằng ngôn ngữ thông thường hoặc gọi lệnh có tiền tố không gian tên. `delegate` là một
[skill](skills/delegate/SKILL.md) (bộ hướng dẫn chuyên biệt); các mục còn lại nằm trong
[commands/](commands/). Một số tài liệu được liên kết, như `CHANGELOG.md` và các tệp trong
`skills/…/references`, hiện chỉ có bản tiếng Anh.

| Lệnh | Kết quả |
|---|---|
| `/omp:delegate <task>` | Xác định phạm vi, soạn brief, khởi chạy, chờ, trả lời, kiểm tra, tích hợp và báo cáo. |
| `/omp:review [--staged \| --base REF \| --commit SHA \| --job ID] [--focus TEXT] [-m MODEL]` | Kiểm tra chỉ đọc; nếu không chọn đối tượng thì kiểm tra các thay đổi chưa commit, kể cả tệp chưa được theo dõi. |
| `/omp:adversarial-review …` | Cùng các đối tượng trên; yêu cầu mô hình kiểm tra tìm cách làm thay đổi thất bại. |
| `/omp:status [JOB \| --group NAME]` | Các job của kho mã này, một job hoặc bản tóm tắt nhóm. |
| `/omp:result JOB` | Báo cáo, các tệp đã thay đổi và chi phí đã ghi nhận. |
| `/omp:cancel JOB` | Hủy một job; mặc định, phụ thuộc không thành công khiến các job phụ thuộc bị bỏ qua. |
| `/omp:transfer` | In lệnh để tiếp tục nội dung hội thoại này trong omp tương tác. |
| `/omp:setup [--stop-gate on\|off]` | Tạo cấu hình còn thiếu, in chẩn đoán và tùy chọn bật/tắt cổng kiểm tra Stop. |

Các lệnh kiểm tra báo cáo phát hiện mà không thay đổi mã. Claude kiểm chứng các tình huống
được viện dẫn; các phát hiện vẫn là nhận định cần đánh giá, không phải chỉ dẫn phải làm theo.
Cổng kiểm tra Stop mặc định tắt trừ khi được bật.

## Tham chiếu CLI

### Vòng đời tác vụ

`omp-task` cũng dùng được từ shell, tập lệnh hoặc một tác nhân khác. Viết brief nêu mục tiêu,
các tệp được phép chỉnh sửa, ràng buộc và lệnh nghiệm thu; sau đó khởi chạy:

```bash
omp-task run --detach --model default --access edit --isolate worktree --timeout 20m --allow 'bun test*' --brief brief.md
```

Thay `JOB` bên dưới bằng ID được trả về:

```bash
omp-task wait JOB
```

Không có `--detach`, `run` tự chờ. Trong Claude, skill cho `wait` chạy nền rồi kết thúc lượt;
người dùng terminal có thể chờ ở chế độ tiền cảnh. Không liên tục truy vấn trạng thái để
mô phỏng việc chờ.

| Lệnh | Mục đích |
|---|---|
| `run [text]`, `continue JOB [text]`, `resume JOB` | Khởi chạy; tạo job mới dùng phiên của một job đã hoàn tất; tiếp tục job bị gián đoạn với ID hiện có. |
| `wait JOB…`, `wait --group NAME`, `watch JOB…` | Chờ sự kiện cần xử lý hoặc hoàn tất, hoặc truyền liên tục các sự kiện. |
| `reply JOB TEXT`, `approve JOB [--session\|--deny]`, `steer JOB TEXT`, `cancel JOB` | Trả lời, phê duyệt/từ chối, điều chỉnh hướng hoặc hủy. |
| `status JOB`, `status --group NAME`, `result JOB [--full]`, `list [-C DIR] [--group NAME]`, `summary NAME` | Xem trạng thái, báo cáo, các job gần đây và chi tiêu của nhóm. |
| `doctor`, `setup`, `daemon [status\|stop]`, `hook NAME`, `install-binary` | Chẩn đoán, cấu hình, điều khiển daemon, hook của plugin và cài tệp nhị phân. |

### Worktree, kiểm tra mã và kế hoạch song song

Với job worktree đã hoàn tất: xem `omp-task diff JOB`, kiểm tra thay đổi, tùy chọn chạy
`omp-task review --job JOB`, rồi chạy `omp-task apply JOB` hoặc `omp-task discard JOB`.
Áp dụng thành công sẽ xóa worktree, trừ khi truyền `--keep`.

Lệnh kiểm tra chấp nhận `--staged`, `--base REF` (tính từ điểm hợp nhất chung), `--commit SHA`
hoặc `--job ID`; thêm `--adversarial` hoặc `--focus TEXT`. Kết luận và phát hiện được kiểm
tra theo lược đồ.

Để phân nhánh thực thi song song, dùng `--group NAME`, `--after JOB` và `{{result:JOB}}` trong
brief. Phụ thuộc thất bại lan truyền trạng thái `skipped`, trừ khi đặt `--after-any-outcome`.
Quan hệ phụ thuộc quy định thứ tự thực thi; chúng không hợp nhất thay đổi từ worktree. Áp
dụng các worktree phụ thuộc theo đúng thứ tự phụ thuộc. Với đồ thị YAML/JSON, dùng
`omp-task plan apply plan.yaml --dry-run` trước khi áp dụng kế hoạch; xem
[hướng dẫn phân nhánh thực thi song song](skills/delegate/references/fan-out.md).

`prune` xóa worktree cũ; `prune --jobs` xóa bản ghi và tệp của các job đã hoàn tất. Cả hai
đều hỗ trợ `--older` và `--dry-run`. Xem trước các mục sẽ bị xóa trước khi xóa công việc
có thể còn cần đến.

### Đầu ra và mã thoát

`run`, `continue`, `resume`, `review`, `wait`, `status`, `result`, `list`, `summary`,
`plan apply` và `daemon status` chấp nhận `--json`. Cờ này không dùng được cho mọi lệnh:
`diff`, `watch` và `doctor` không xuất JSON. `plan apply --dry-run` in bản xem trước dạng
văn bản ngay cả khi có `--json`.

`wait` giới hạn báo cáo hoàn tất thông thường ở 40 dòng và 12.000 ký tự. Dùng `result --full`
để lấy báo cáo đầy đủ, không phải bản ghi hội thoại. Với kiểm tra mã, `result --json` còn
chứa đối tượng kết quả kiểm tra đã được kiểm tra tính hợp lệ. Khi đầu ra được truyền qua
pipe, `watch` mặc định chỉ xuất các sự kiện cần xử lý; `--verbose` bao gồm cả sự kiện
thông thường.

| Mã thoát | Ý nghĩa với `wait` hoặc lệnh tác vụ đang chờ hoàn tất |
|---|---|
| 0 | Tất cả các job được theo dõi đã hoàn tất, hoặc có job cần xử lý: câu hỏi, phê duyệt, checkpoint, ngừng tiến triển hoặc gián đoạn. |
| 1 | Thất bại, bị hủy, hết thời gian, bị bỏ qua do phụ thuộc hoặc vượt ngân sách. |
| 2 | Lỗi sử dụng hoặc cấu hình. |
| 3 | Hết `--max-wait`; chỉ dừng chờ, không dừng job. |
| 5 | Daemon không khả dụng hoặc môi trường chạy mã nguồn không khởi động được. |

Mã thoát 0 không có nghĩa là đã xong: đọc dòng cuối. `WAKE: done (…)` nghĩa là mọi job đã
kết thúc; `WAKE: <job> <lý do>` nghĩa là có job cần xử lý, kèm một dòng `PENDING:` cho mỗi
câu hỏi hoặc yêu cầu phê duyệt đang mở ngay phía trên. Xử lý mục đó rồi chờ tiếp. Khởi chạy
bằng chế độ tách rời
trả về 0 khi gửi job thành công, không phải khi tác vụ hoàn tất. Chạy `omp-task --help` để xem toàn bộ cờ.

## Quyền truy cập, tách biệt và quy tắc phê duyệt

### Các chế độ truy cập

| `--access` | Quyền của bên thực thi | Cách dùng điển hình |
|---|---|---|
| `read` | Chỉ có các công cụ đọc/tìm kiếm giới hạn, tìm kiếm web và theo dõi tác vụ; không có shell hay công cụ chỉnh sửa tệp. | Nghiên cứu và kiểm tra mã. |
| `edit` (mặc định) | Chỉnh sửa tệp không cần phê duyệt; yêu cầu thực thi cần phê duyệt được chuyển tới Claude hoặc quyết định theo quy tắc. | Thay đổi mã trong phạm vi xác định. |
| `full` | Chế độ phê duyệt `yolo` của omp: không hỏi phê duyệt. | Tác vụ đáng tin cậy cần thực thi shell. |

Quy tắc phê duyệt chỉ quyết định các yêu cầu do omp gửi. Quy tắc từ chối không phải rào cản
thực thi khi bên thực thi chạy mà không hỏi phê duyệt. Ranh giới chỉnh sửa trong brief và
worktree không phải sandbox của hệ điều hành: không xem chúng là biện pháp bảo vệ trước
mã hoặc mô hình không đáng tin cậy.

### Tách biệt bằng worktree

Mặc định, `--isolate auto` chỉ chọn worktree cho job toàn quyền trong kho Git có commit.
Trong các trường hợp khác, job dùng bản checkout hiện tại — kể cả job toàn quyền ở ngoài
kho mã đáp ứng điều kiện trên. Quyền chỉnh sửa không tự động tách biệt. Dùng rõ
`--isolate worktree` khi cần tách biệt; tùy chọn này từ chối kho mã không phù hợp.
`--isolate none` buộc dùng bản checkout hiện tại.

Job chạy trong checkout dùng chung thư mục với bạn và với mọi session khác đang làm việc ở đó.
Ngoài danh sách file đã thay đổi, báo cáo của job còn liệt kê riêng những file mà tool
edit/write của worker không đụng tới: do lệnh shell của nó hoặc do người khác tạo ra. Hãy kiểm
tra các file đó trước khi revert hay xoá. Worker không kế thừa session Claude Code hay pane
terminal (Orca, tmux) của session đã khởi động daemon; mỗi worker chỉ mang session id của job
của chính nó.

Worktree bắt đầu từ HEAD, nằm dưới thư mục trạng thái, trên nhánh `omp/JOB`. Các thay đổi
chưa commit hiện có không được đưa vào, trừ khi dùng `--carry-dirty` để sao chép chúng, kể
cả các tệp chưa được theo dõi và không bị bỏ qua; chúng được commit trên nhánh của job làm
điểm xuất phát, nên `diff` và `apply` chỉ hiển thị thay đổi của bên thực thi. `continue` kế
thừa chế độ tách biệt và worktree của job cha chừng nào worktree đó vẫn còn: lặp lại trước
khi `apply` thông thường hoặc `discard` xóa worktree.

`apply` thông thường kiểm tra bản vá trước khi áp dụng. **`apply --3way` có thể để lại dấu
xung đột và các tệp chưa hợp nhất trong bản checkout chính**, ngay cả khi bước kiểm tra
đã thành công. Kiểm tra và giải quyết các tệp đó trước khi tiếp tục. `discard` và việc dọn
worktree xóa thay đổi của bên thực thi mà không áp dụng chúng; cả hai đều không phải lệnh
hoàn tác các thay đổi đã áp dụng.

### Quy tắc phê duyệt

Có thể lặp lại `--allow GLOB` và `--deny GLOB`; chúng khớp với toàn bộ nội dung yêu cầu phê
duyệt: `*` khớp mọi chuỗi và `?` khớp một ký tự. Quy tắc từ chối được ưu tiên. Quy tắc cho
Chuỗi lệnh nối bằng `&&`, `||` hoặc `;` được tách thành từng lệnh (dấu phân cách nằm trong
dấu nháy không tính): quy tắc cho phép theo mẫu lệnh như `--allow 'bun test*'` chỉ duyệt khi
mọi lệnh đều khớp một quy tắc cho phép, và quy tắc từ chối khớp bất kỳ lệnh nào sẽ từ chối cả
chuỗi. Quy tắc theo mẫu lệnh không bao giờ duyệt pipe, `&` chạy nền, chuyển hướng, thay thế
lệnh, dấu backtick và ký tự xuống dòng. Các lệnh bash no-op `true` và `:` được duyệt mà không
cần quy tắc.

**Quy tắc cho phép toàn bộ công cụ như `--allow 'tool:bash'` bỏ qua bộ lọc đó.**
Dùng mẫu lệnh có phạm vi hẹp, trừ khi chủ ý cấp quyền cho toàn bộ công cụ. Các quy tắc không
kiểm tra hoạt động bên trong tập lệnh được cho phép.

`approve JOB` phê duyệt một yêu cầu đang chờ; `--session` cho phép chính công cụ đó trong phần
còn lại của job (yêu cầu cho công cụ khác vẫn phải hỏi), còn `--deny` từ chối yêu cầu.
Mặc định, câu hỏi và yêu cầu phê duyệt hết hạn sau 20 phút, được điều khiển bằng `--answer-timeout` và `--approval-timeout`. Yêu cầu phê duyệt hết hạn
sẽ bị từ chối; câu hỏi hết hạn cho phép bên thực thi tiếp tục dựa trên một giả định.

## Cấu hình

### Vị trí cấu hình và preset (bộ cấu hình đặt sẵn)

Tệp mặc định là `~/.config/claude-omp/config.json`, hoặc
`$XDG_CONFIG_HOME/claude-omp/config.json`. `OMP_TASK_CONFIG` ghi đè toàn bộ đường dẫn.
[config.example.json](config.example.json) chứa các giá trị thiết lập và các preset có tên.
Ví dụ, preset `cheap` trong tệp đó là:

```json
{
  "model": "smol",
  "access": "edit",
  "timeout": "20m"
}
```

Chọn bằng `--preset cheap`. Các vai trò mô hình như `default`, `smol` và `slow` được phân
giải qua cấu hình riêng của omp; xem bằng `omp config get modelRoles`. Preset kết hợp các
thiết lập tác vụ; bản thân nó không phải vai trò mô hình.

Các thiết lập tác vụ dạng đơn trị thường được phân giải theo thứ tự ưu tiên: cờ → preset →
job cha khi dùng `continue` → `defaults` của người dùng → giá trị dự phòng tích hợp sẵn.
Quyền truy cập mặc định là `edit`, thời gian tối đa là `30m`, thông báo ngừng tiến triển
là `10m` (`stall_timeout: 0` tắt thông báo không có hoạt động). Danh sách phê duyệt được
hợp nhất từ giá trị mặc định, preset, job cha và cờ. Việc tiếp tục job kế thừa chế độ tách
biệt thay vì thay thế nó theo chuỗi ưu tiên trên.

### Thực thi đồng thời, chi tiêu và vòng đời

`max_concurrent` mặc định là 4. `max_writers_per_repo` mặc định là 1 cho các job chỉnh sửa
trực tiếp cùng một bản checkout; các job ghi trong worktree tách biệt không dùng chung
suất ghi đó. Job bị gián đoạn (`interrupted`) vẫn giữ suất của nó cho đến khi được `resume`
hoặc `cancel`, nên khởi động lại daemon không để job đang xếp hàng chạy thế chỗ. Nhóm hỗ trợ `max_concurrent` và `budget_usd`; `budget`/`--budget` cho từng job
và `daily_budget_usd` cũng giới hạn chi tiêu. Job vượt ngân sách dừng với trạng thái
`over_budget`; ngân sách không phải mức trần cứng được trả trước.

Thiết lập ban đầu đặt ngân sách hằng ngày là $10. Không có cấu hình đó thì không có mức
trần hằng ngày tích hợp sẵn. Không tự động nạp cấu hình cục bộ của kho mã, nhưng các cờ
được chỉ định ảnh hưởng đến thiết lập tác vụ và tệp kế hoạch được chọn có thể ghi đè giới
hạn nhóm đã cấu hình. Đây không phải chính sách quản trị bất biến; kiểm tra kế hoạch
trước khi chạy.

`auto_resume` mặc định tắt trừ khi được bật. Daemon tự dừng sau 15 phút không có job hay
máy khách. `on_session_end` mặc định là `keep`; `cancel` dừng các job của phiên Claude đó.
Các job đã hoàn tất và tệp của chúng hết thời hạn lưu giữ sau `job_retention` (30 ngày);
`0` tắt việc tự động xóa theo thời hạn lưu giữ. Job sở hữu worktree được giữ lại cho đến
khi worktree đó bị xóa.

`stop_gate` tùy chọn mặc định dùng mô hình `smol`, thời gian tối đa `3m`, mức nghiêm trọng
tối thiểu `high` và tối đa 3 lần kiểm tra mỗi phiên Claude. Bật bằng
`/omp:setup --stop-gate on`; dùng `off` để tắt. Cổng này bỏ qua diff không thay đổi và các
hook Stop đệ quy. **Khi lỗi, cổng vẫn cho phép tiếp tục:** kiểm tra thất bại, hết thời gian
hoặc chưa hoàn tất vì lý do khác không chặn Claude. Mỗi lần kiểm tra đều dùng tài nguyên
nhà cung cấp; đạt giới hạn số lần kiểm tra không có nghĩa các thay đổi sau đó đã được
chứng nhận.

### Ghi đè bằng biến môi trường

| Biến | Mục đích |
|---|---|
| `OMP_TASK_HOME` | Thư mục trạng thái, gồm cơ sở dữ liệu, các job và worktree. |
| `OMP_TASK_CONFIG` | Đường dẫn tệp cấu hình người dùng. |
| `OMP_TASK_OMP_BIN` | Đường dẫn hoặc tên chương trình thực thi. |
| `OMP_TASK_DAEMON_IDLE` | Thời gian chờ không hoạt động của daemon, tính bằng giây. |

`XDG_STATE_HOME` thay đổi thư mục gốc trạng thái mặc định; `XDG_RUNTIME_DIR` thay đổi vị trí
socket. Daemon chạy lâu dài và kế thừa môi trường lúc khởi chạy: thay đổi biến trong shell
của máy khách mới không cấu hình lại tiến trình đang chạy.

## Cách hoạt động

### Từ brief đến kết quả

`omp-task` giao tiếp bằng HTTP qua Unix socket với một daemon cho mỗi thư mục trạng thái,
khởi chạy daemon khi cần. Daemon quản lý trạng thái job trong SQLite, lập lịch và khởi
chạy `omp --mode rpc` với các cờ truy cập, mô hình đã chọn và
[phần chỉ dẫn mở đầu cho bên thực thi](src/prompts/worker-preamble.md). Bên thực thi có thể
hỏi qua `ask_orchestrator`, báo cáo qua `notify_orchestrator` và gửi kết quả kiểm tra có
cấu trúc qua `submit_review`. Daemon theo dõi hoạt động công cụ và chi phí, chuyển tiếp
yêu cầu phê duyệt và thực thi giới hạn thời gian, ngân sách.

Phần chỉ dẫn mở đầu yêu cầu bên thực thi giữ đúng phạm vi, hỏi thay vì đoán và tránh tạo
commit. Claude vẫn kiểm tra thay đổi thực tế và tiêu chí nghiệm thu; báo cáo cuối của bên
thực thi không phải bằng chứng về tính đúng đắn. Tạo commit không thuộc quy trình giao tác
vụ mặc định.

### Trạng thái, hook và khôi phục

Trạng thái mặc định nằm trong `~/.local/state/claude-omp/`: `state.db`, `jobs/JOB/`, các
worktree và nhật ký daemon. Các tệp lưu lại của job gồm lời nhắc, sự kiện RPC (gọi thủ tục
từ xa) thô (`events.jsonl`), kết quả và tài liệu kiểm tra. Chúng có thể chứa mã nguồn và
ngữ cảnh tác vụ nhạy cảm; che thông tin nhạy cảm trước khi chia sẻ.

SessionStart ghi lại ID phiên Claude, SessionEnd có thể hủy các job của phiên theo cấu hình
và Stop chạy cổng kiểm tra nếu đã bật. Job bị gián đoạn thường tiếp tục phiên omp đã lưu
bằng `resume`; nếu omp chưa từng lưu phiên, tác vụ có thể khởi chạy lại thay thế. `continue`
dùng để phản hồi về job đã hoàn tất và tạo bản ghi job mới.

Khi máy khách kết nối, daemon không có job đang chạy và khác phiên bản sẽ bị thay thế —
không chỉ khi máy khách mới hơn. Các job đang hoạt động ngăn việc thay thế đó; kết nối
sau có thể thay daemon khi chúng hoàn tất. Daemon cũng dừng sau thời gian chờ không hoạt động.

## Xử lý sự cố và câu hỏi thường gặp

### Thiết lập và tìm lệnh

| Triệu chứng | Cách xử lý |
|---|---|
| Thiếu lệnh bắt đầu bằng dấu gạch chéo | Xác nhận đã cài bằng `claude plugin list`, rồi chạy `/reload-plugins` trong Claude. |
| `omp-task` chạy được trong Claude nhưng không chạy được trong terminal | PATH của plugin chỉ áp dụng cho công cụ Bash của Claude. Dùng trình cài CLI từ checkout và kiểm tra `~/.local/bin` có trên PATH. |
| Thiếu Bun | Cài Bun hoặc chạy `omp-task install-binary` qua trình khởi chạy của plugin. |
| omp hoặc mô hình đã chọn gặp lỗi | Chạy `omp-task doctor`, rồi kiểm tra `omp login`, `omp models` và ánh xạ vai trò mô hình. Doctor không xác minh thông tin xác thực với nhà cung cấp. |

### Job, worktree và kiểm tra mã

`wait` có vẻ im lặng là bình thường: tiến độ thông thường không đánh thức lệnh này.
`WAKE: <job> <lý do>` có nghĩa cần trả lời bằng `reply`, quyết định yêu cầu `approve`, xem checkpoint/tình trạng
ngừng tiến triển hoặc dùng `resume JOB --detach` cho job bị gián đoạn; sau đó chạy lại đúng
lệnh `wait` cũ. `watch JOB --verbose --last 40` in các sự kiện mới nhất rồi thoát, kể cả khi
job còn chạy; `watch` thông thường theo dõi đến khi job kết thúc.

Với job `queued`, dòng `queued:` của `run --detach` và `status` cho biết giới hạn nào hoặc
job nào đang giữ chỗ (kể cả khi job đó thuộc một session Claude khác). `blocked` là đang
chờ phụ thuộc; `skipped` nghĩa là một phụ thuộc bắt buộc không hoàn tất. Với `over_budget`,
xem chi tiêu của job, nhóm và trong ngày bằng `status`, `result` và `summary` trước khi thử lại.

Nếu `apply` thất bại, xem `diff` và lỗi trước khi thay đổi bản checkout. Không thử lại một
cách mù quáng bằng `--3way`: tùy chọn này có thể để lại xung đột hợp nhất. Cổng kiểm tra Stop
im lặng có thể do bị tắt, bỏ qua diff lặp lại, đã đạt giới hạn của phiên hoặc gặp lỗi nhưng
vẫn cho qua — không nhất thiết có nghĩa là mã đã được chấp thuận.

Với lỗi kết nối daemon, xem `daemon.out` và `daemon.log` trong thư mục trạng thái. Báo lỗi
có thể tái hiện tại [GitHub issues](https://github.com/taina0407/claude-omp/issues), kèm
phiên bản CLI/omp, chẩn đoán và thông báo lỗi đã che thông tin nhạy cảm. Không tải lên các
tệp lưu lại của job khi chưa kiểm tra nội dung.

## Phát triển

### Kiểm tra cục bộ

Từ bản checkout này:

```bash
bun install
```

```bash
bun run check
```

```bash
claude plugin validate . --strict
```

`check` chạy kiểm tra TypeScript, Biome và bộ kiểm thử. Kiểm thử thông thường điều khiển CLI
và daemon thật với omp giả lập, đồng thời phát lại dữ liệu RPC mẫu đã ghi, nên không cần
truy cập nhà cung cấp. Kiểm thử hợp đồng với nhà cung cấp thật bị bỏ qua trừ khi được bật rõ.

### Kiểm tra với nhà cung cấp thật và biên dịch bản phát hành

Chạy kiểm thử hợp đồng với omp đã cài và vai trò `smol`:

```bash
bun run contract
```

Hoặc chọn mô hình khác cho kiểm thử hợp đồng:

```bash
OMP_CONTRACT_MODEL=task bun run contract
```

Các lệnh này gọi nhà cung cấp thật và có thể phát sinh phí. Để cập nhật bản ghi RPC:

```bash
bun run record
```

Biên dịch các tệp nhị phân tự chứa và `SHA256SUMS` trong `dist/`:

```bash
bun run build
```

Đẩy thẻ phiên bản khớp `v*` sẽ chạy kiểm tra, biên dịch tệp nhị phân và xuất bản bản phát hành;
xem [quy trình phát hành](.github/workflows/release.yml).
[Mẫu brief](skills/delegate/references/brief-template.md),
[hướng dẫn mô hình/quyền truy cập](skills/delegate/references/models-and-access.md) và
[hướng dẫn phân nhánh thực thi song song](skills/delegate/references/fan-out.md) có các ví dụ
giao tác vụ chi tiết. Dùng `omp-task --help` để xem cờ và tệp cấu hình mẫu để xem các thiết
lập, thay vì lặp lại những tài liệu tham chiếu đó ở đây.

## Nâng cấp và gỡ cài đặt

### Nâng cấp

Đọc [CHANGELOG.md](CHANGELOG.md) để biết thay đổi theo từng bản phát hành. Nâng cấp plugin đã cài:

```bash
claude plugin update omp@omp-tools
```

Tải lại plugin trong các phiên đang mở. Khi một bản phát hành thay đổi cấu trúc cơ sở dữ liệu
job, daemon đặt lại cơ sở dữ liệu ở lần khởi động đầu tiên: các bản ghi job trước đó bị xóa,
còn tệp của job và worktree trên đĩa vẫn được giữ đến khi bạn tự xóa. Thiết lập giữ nguyên cấu hình hiện có, nên đối
chiếu với tệp mẫu hiện tại khi dùng thiết lập mới. Tệp nhị phân phát hành khác phiên bản
sẽ bị bỏ qua; chạy lại `omp-task install-binary` nếu dùng môi trường chạy đó.

### Gỡ cài đặt

Gỡ plugin:

```bash
claude plugin uninstall omp@omp-tools
```

Với bản cài từ checkout, dùng trình gỡ cài đặt của nó thay thế:

```bash
./install.sh --uninstall
```

Trình gỡ cài đặt từ checkout xóa liên kết tượng trưng CLI và plugin, đồng thời buộc daemon
dừng, làm gián đoạn các job đang hoạt động. Cấu hình và trạng thái người dùng được giữ lại.
Xóa dữ liệu đã giữ lại là lựa chọn riêng có tính phá hủy; gỡ cài đặt không tự động xóa chúng.

## Giấy phép

[MIT](LICENSE). Được xây dựng dựa trên [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi).

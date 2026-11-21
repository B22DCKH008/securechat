import type { BenchCase } from './bench';

/**
 * Mẫu để đo ĐỘ TRỄ (không dùng để đánh giá chất lượng). Nội dung tự viết, chỉ cần đa dạng độ dài.
 * Tình huống xấu nhất quan trọng hơn trung bình: tin rất dài, nhiều URL, nhiều ký tự có dấu.
 */
const filler = 'Hôm nay trời đẹp nên mình rủ bạn đi cà phê, nhớ mang theo laptop nhé. ';

export const BENCH_CASES: BenchCase[] = [
  { name: 'Tin ngắn (20 ký tự)', kind: 'message', input: 'Chiều nay đi ăn không?' },
  {
    name: 'Tin trung bình (~200 ký tự)',
    kind: 'message',
    input:
      'Chào bạn, tài khoản của bạn có giao dịch bất thường. Vui lòng xác thực lại thông tin tại liên kết bên dưới trong vòng 24 giờ để tránh bị khóa. Cảm ơn bạn đã sử dụng dịch vụ.',
  },
  { name: 'Tin dài (~1000 ký tự)', kind: 'message', input: filler.repeat(14) },
  {
    name: 'Tin rất dài (4000 ký tự, tối đa của ô nhập)',
    kind: 'message',
    input: filler.repeat(56).slice(0, 4000),
  },
  {
    name: 'Tin có nhiều số/URL',
    kind: 'message',
    input:
      'Chuyển 5000000 vào 0123456789012 ngay tại https://example.com/a?b=1 hoặc http://bit.ly/abc123 '.repeat(
        8,
      ),
  },
  { name: 'URL ngắn', kind: 'url', input: 'https://example.com' },
  {
    name: 'URL dài có tham số',
    kind: 'url',
    input:
      'https://secure-login.example-bank.com.verify.tk/account/update?session=' +
      'a1b2c3d4'.repeat(40),
  },
];

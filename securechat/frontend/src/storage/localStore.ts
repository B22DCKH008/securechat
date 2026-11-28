import type { ScamReport, UserAccount } from '../features/auth/types';
import type { Conversation } from '../features/conversations/types';

const KEYS = {
  users: 'securechat_users_v4',
  session: 'securechat_session_v4',
  reports: 'securechat_reports_v4',
  aliases: 'securechat_aliases_v4',
  convs: 'securechat_convs_v4',
};

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(raw));
}

export function normalizePhone(raw: string): string {
  let digits = raw.replace(/[\s.\-()]/g, '');
  if (digits.startsWith('+84')) digits = '0' + digits.slice(3);
  else if (digits.startsWith('84') && digits.length === 11) digits = '0' + digits.slice(2);
  return digits;
}

export function isValidVnPhone(raw: string): boolean {
  return /^0(3|5|7|8|9)[0-9]{8}$/.test(normalizePhone(raw));
}

export async function hashPassword(raw: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sc:${raw}`));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv-${(h >>> 0).toString(16)}`;
}

const DEMO_PW_PLAIN = '123456';

const SEED_USERS: Array<Omit<UserAccount, 'passwordHash'>> = [
  {
    id: 'u-vu',
    username: 'vu.tran',
    displayName: 'Trần Tiến Vũ',
    email: 'vu.tran@securechat.vn',
    phone: '0912000001',
    emailVerified: true,
    phoneVerified: true,
    avatarText: 'TV',
    avatarColor: '#0068ff',
    bio: 'Sinh viên CNTT · Bật lá chắn AI on-device',
    isOnline: true,
    createdAt: '2026-11-01T08:00:00Z',
  },
  {
    id: 'u-linh',
    username: 'linh.nguyen',
    displayName: 'Nguyễn Khánh Linh',
    email: 'linh.nguyen@securechat.vn',
    phone: '0912000002',
    emailVerified: true,
    phoneVerified: true,
    avatarText: 'KL',
    avatarColor: '#ec4899',
    bio: 'Tài khoản người dùng thứ 2 (dùng để kiểm chứng cảnh báo tố cáo)',
    isOnline: true,
    createdAt: '2026-11-02T09:00:00Z',
  },
  {
    id: 'u-email-only',
    username: 'demo.email',
    displayName: 'Tài khoản Email (Chưa gắn SĐT)',
    email: 'demo.email@securechat.vn',
    phone: '',
    emailVerified: true,
    phoneVerified: false,
    avatarText: 'EM',
    avatarColor: '#0891b2',
    bio: 'Dùng để demo luồng đăng nhập Email rồi bắt buộc xác thực SĐT',
    isOnline: true,
    createdAt: '2026-11-25T09:00:00Z',
  },
  {
    id: 'u-tuan',
    username: 'tuan.minh',
    displayName: 'Minh Tuấn',
    email: 'tuan.minh@securechat.vn',
    phone: '0912000003',
    emailVerified: true,
    phoneVerified: true,
    avatarText: 'MT',
    avatarColor: '#059669',
    bio: 'Bạn cùng phòng · Hà Đông',
    isOnline: true,
    createdAt: '2026-11-03T10:00:00Z',
  },
  {
    id: 'u-nam',
    username: 'nam.hoang',
    displayName: 'Hoàng Nam',
    email: 'nam.hoang@securechat.vn',
    phone: '0912000004',
    emailVerified: true,
    phoneVerified: true,
    avatarText: 'HN',
    avatarColor: '#2563eb',
    bio: 'Nhóm Đồ án AI - K22',
    isOnline: true,
    createdAt: '2026-11-04T11:00:00Z',
  },
  {
    id: 'u-mentor-scam',
    username: 'minhanh.invest',
    displayName: 'Minh Anh · Tư vấn Đầu tư',
    email: 'minhanh.invest@mail-tam.net',
    phone: '0966123456',
    emailVerified: true,
    phoneVerified: true,
    avatarText: 'MA',
    avatarColor: '#be123c',
    bio: 'Chia sẻ kiến thức tài chính cá nhân',
    isOnline: true,
    createdAt: '2026-11-15T08:00:00Z',
  },
  {
    id: 'u-bank-scam',
    username: 'hotro.the247',
    displayName: 'Hỗ trợ Thẻ 24/7 (Số lạ)',
    email: 'hotro.the247@mail-tam.net',
    phone: '0988000999',
    emailVerified: true,
    phoneVerified: true,
    avatarText: 'NH',
    avatarColor: '#dc2626',
    bio: 'Tài khoản chưa xác thực danh tính',
    isOnline: false,
    createdAt: '2026-11-20T07:30:00Z',
  },
  {
    id: 'u-shipper-scam',
    username: 'shipper.0903',
    displayName: 'Shipper Giao Hàng (0903xxx)',
    email: 'shipper.0903@mail-tam.net',
    phone: '0903847261',
    emailVerified: true,
    phoneVerified: true,
    avatarText: 'GH',
    avatarColor: '#ea580c',
    bio: 'Giao hàng nhanh khu vực Hà Nội',
    isOnline: false,
    createdAt: '2026-11-21T07:30:00Z',
  },
  {
    id: 'u-promo',
    username: 'uudai.ngoaingu',
    displayName: 'Ưu đãi Học viện Ngoại ngữ',
    email: 'tuyensinh@ngoaingu-promo.vn',
    phone: '0977000888',
    emailVerified: true,
    phoneVerified: true,
    avatarText: 'QC',
    avatarColor: '#7c3aed',
    bio: 'Tài khoản quảng bá khóa học',
    isOnline: false,
    createdAt: '2026-11-18T12:00:00Z',
  },
];

const SEED_REPORTS: ScamReport[] = [
  {
    id: 'rep-seed-1',
    targetUserId: 'u-bank-scam',
    reporterUserId: 'u-tuan',
    reporterName: 'Minh Tuấn',
    reason: 'Giả mạo ngân hàng / cơ quan chức năng',
    note: 'Gửi link giả mạo vcb-xacminh.top và hỏi mã OTP 6 số.',
    createdAt: '2026-11-26T10:15:00Z',
  },
  {
    id: 'rep-seed-2',
    targetUserId: 'u-bank-scam',
    reporterUserId: 'u-nam',
    reporterName: 'Hoàng Nam',
    reason: 'Yêu cầu cung cấp mã OTP / mật khẩu',
    note: 'Dọa khóa tài khoản sau 2 giờ để dụ nhập OTP.',
    createdAt: '2026-11-26T18:40:00Z',
  },
];

export function buildInitialConversationsForUser(currentUser: UserAccount): Conversation[] {
  return [
    {
      id: 'conv-longterm-scam',
      type: 'direct',
      peerUserId: 'u-mentor-scam',
      name: 'Minh Anh · Tư vấn Đầu tư',
      avatarText: 'MA',
      avatarColor: '#be123c',
      subtitle: '0966123456 · Người lạ (Kịch bản dài ngày)',
      isOnline: true,
      isStranger: true,
      messages: [
        {
          id: 'm-lt-1',
          senderId: 'u-mentor-scam',
          senderName: 'Minh Anh',
          direction: 'incoming',
          text: 'Chào bạn nhé, tình cờ thấy bạn cùng quan tâm công nghệ nên mình kết bạn làm quen cho vui.',
          timestamp: 'Ngày 1 · 09:10',
          analysis: { status: 'unavailable' },
        },
        {
          id: 'm-lt-2',
          senderId: currentUser.id,
          senderName: currentUser.displayName,
          direction: 'outgoing',
          text: 'Chào bạn, rất vui được biết bạn.',
          timestamp: 'Ngày 1 · 09:25',
          deliveryStatus: 'read',
          analysis: { status: 'unavailable' },
        },
        {
          id: 'm-lt-3',
          senderId: 'u-mentor-scam',
          senderName: 'Minh Anh',
          direction: 'incoming',
          text: 'Dạo này cuối tuần bạn hay làm gì? Mình tranh thủ tối chia sẻ bí quyết tạo thu nhập thụ động cùng nhóm bạn thôi.',
          timestamp: 'Ngày 2 · 20:15',
          analysis: { status: 'unavailable' },
        },
        {
          id: 'm-lt-4',
          senderId: 'u-mentor-scam',
          senderName: 'Minh Anh',
          direction: 'incoming',
          text: 'Nếu bạn tin tưởng mình thì tối nay sang Telegram vào nhóm VIP nghe thầy hướng dẫn từng bước nhé.',
          timestamp: 'Ngày 3 · 19:40',
          analysis: { status: 'unavailable' },
        },
        {
          id: 'm-lt-5',
          senderId: 'u-mentor-scam',
          senderName: 'Minh Anh',
          direction: 'incoming',
          text: 'Bạn tải app sàn giao dịch rồi nạp thử 200k thôi, lát chốt lệnh có lợi nhuận là rút vốn về tài khoản ngay.',
          timestamp: 'Ngày 4 · 14:05',
          analysis: { status: 'unavailable' },
        },
      ],
    },
    {
      id: 'conv-group-ai',
      type: 'group',
      name: 'Nhóm Đồ Án AI - K22',
      avatarText: 'AI',
      avatarColor: '#2563eb',
      subtitle: '4 thành viên · Đang hoạt động',
      isOnline: true,
      messages: [
        {
          id: 'm-101',
          senderId: 'u-nam',
          senderName: 'Hoàng Nam',
          direction: 'incoming',
          text: 'Mình vừa push code phần giao diện lên GitHub rồi, bạn pull về chạy thử xem ổn chưa nhé.',
          timestamp: '14:12',
          analysis: { status: 'unavailable' },
        },
        {
          id: 'm-102',
          senderId: currentUser.id,
          senderName: currentUser.displayName,
          direction: 'outgoing',
          text: 'Ok nhé, mình vừa chạy parity TypeScript xong, lệch xác suất chỉ 1.37e-8 thôi.',
          timestamp: '14:15',
          deliveryStatus: 'read',
          analysis: { status: 'unavailable' },
        },
        {
          id: 'm-103',
          senderId: 'u-linh',
          senderName: 'Nguyễn Khánh Linh',
          direction: 'incoming',
          text: 'Tối nay 9h cả nhóm họp Google Meet chốt slide bảo vệ nhé: https://meet.google.com/abc-defg-hij',
          timestamp: '14:20',
          analysis: { status: 'unavailable' },
        },
      ],
    },
    {
      id: 'conv-bank-stranger',
      type: 'direct',
      peerUserId: 'u-bank-scam',
      name: 'Hỗ trợ Thẻ 24/7 (Số lạ)',
      avatarText: 'NH',
      avatarColor: '#dc2626',
      subtitle: '0988000999 · Người lạ',
      isOnline: false,
      isStranger: true,
      messages: [
        {
          id: 'm-201',
          senderId: 'u-bank-scam',
          senderName: 'Hỗ trợ Thẻ 24/7',
          direction: 'incoming',
          text: 'Cảnh báo khẩn: Tài khoản ngân hàng của quý khách sẽ bị khóa sau 2 giờ nữa do chưa đồng bộ sinh trắc học, xác minh ngay tại https://vcb-xacminh.top/login',
          timestamp: '15:02',
          analysis: { status: 'unavailable' },
        },
        {
          id: 'm-202',
          senderId: 'u-bank-scam',
          senderName: 'Hỗ trợ Thẻ 24/7',
          direction: 'incoming',
          text: 'a oi doc giup e ma otp 6 so vua gui ve sms de ben e huy phi thuong nien 2tr4 cho a nhe',
          timestamp: '15:04',
          analysis: { status: 'unavailable' },
        },
      ],
    },
    {
      id: 'conv-shipper',
      type: 'direct',
      peerUserId: 'u-shipper-scam',
      name: 'Shipper Giao Hàng (0903xxx)',
      avatarText: 'GH',
      avatarColor: '#ea580c',
      subtitle: '0903847261 · Người lạ',
      isOnline: false,
      isStranger: true,
      messages: [
        {
          id: 'm-301',
          senderId: 'u-shipper-scam',
          senderName: 'Shipper Giao Hàng',
          direction: 'incoming',
          text: 'Alo anh ơi em giao đơn 45k đang đứng ở cổng gọi không thấy nghe máy, anh ck trước vào STK 0903847261 để em gửi bảo vệ nhé.',
          timestamp: '15:18',
          analysis: { status: 'unavailable' },
        },
      ],
    },
    {
      id: 'conv-roommate',
      type: 'direct',
      peerUserId: 'u-tuan',
      name: 'Minh Tuấn',
      avatarText: 'MT',
      avatarColor: '#059669',
      subtitle: '0912000003 · Đang hoạt động',
      isOnline: true,
      messages: [
        {
          id: 'm-401',
          senderId: 'u-tuan',
          senderName: 'Minh Tuấn',
          direction: 'incoming',
          text: 'Tối nay mấy giờ anh em mình đi ăn bún đậu đầu ngõ thế?',
          timestamp: '15:30',
          analysis: { status: 'unavailable' },
        },
        {
          id: 'm-402',
          senderId: currentUser.id,
          senderName: currentUser.displayName,
          direction: 'outgoing',
          text: 'Tầm 7h nhé, tiền điện nước tháng này 320k mình vừa ck vào tài khoản bạn rồi đó.',
          timestamp: '15:32',
          deliveryStatus: 'delivered',
          analysis: { status: 'unavailable' },
        },
      ],
    },
  ];
}

function safeRead<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function safeWrite(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Bỏ qua nếu vượt quota trình duyệt
  }
}

export async function ensureSeedUsers(): Promise<UserAccount[]> {
  const existing = safeRead<UserAccount[]>(KEYS.users, []);
  if (existing.length > 0) return existing;
  const pwHash = await hashPassword(DEMO_PW_PLAIN);
  const seeded: UserAccount[] = SEED_USERS.map((u) => ({ ...u, passwordHash: pwHash }));
  safeWrite(KEYS.users, seeded);
  return seeded;
}

export function saveUsers(users: UserAccount[]): void {
  safeWrite(KEYS.users, users);
}

export function loadSessionUserId(): string | null {
  return safeRead<string | null>(KEYS.session, null);
}

export function saveSessionUserId(userId: string | null): void {
  safeWrite(KEYS.session, userId);
}

export function loadReports(): ScamReport[] {
  const existing = safeRead<ScamReport[] | null>(KEYS.reports, null);
  if (existing !== null) return existing;
  safeWrite(KEYS.reports, SEED_REPORTS);
  return SEED_REPORTS;
}

export function saveReports(reports: ScamReport[]): void {
  safeWrite(KEYS.reports, reports);
}

export function loadAliasesForUser(userId: string): Record<string, string> {
  const all = safeRead<Record<string, Record<string, string>>>(KEYS.aliases, {});
  return all[userId] ?? {};
}

export function saveAliasForUser(userId: string, convId: string, nickname: string): Record<string, string> {
  const all = safeRead<Record<string, Record<string, string>>>(KEYS.aliases, {});
  const nextForUser = { ...(all[userId] ?? {}) };
  const trimmed = nickname.trim();
  if (trimmed) {
    nextForUser[convId] = trimmed;
  } else {
    delete nextForUser[convId];
  }
  all[userId] = nextForUser;
  safeWrite(KEYS.aliases, all);
  return nextForUser;
}

export function loadConversationsForUser(user: UserAccount): Conversation[] {
  const all = safeRead<Record<string, Conversation[]>>(KEYS.convs, {});
  if (all[user.id] && all[user.id].length > 0) {
    return all[user.id];
  }
  const initial = buildInitialConversationsForUser(user);
  all[user.id] = initial;
  safeWrite(KEYS.convs, all);
  return initial;
}

export function saveConversationsForUser(userId: string, convs: Conversation[]): void {
  const all = safeRead<Record<string, Conversation[]>>(KEYS.convs, {});
  const sanitized = convs.map((c) => ({
    ...c,
    messages: c.messages.map((m) => ({
      ...m,
      imageUrl: m.imageUrl?.startsWith('blob:') ? undefined : m.imageUrl,
    })),
  }));
  all[userId] = sanitized;
  safeWrite(KEYS.convs, all);
}
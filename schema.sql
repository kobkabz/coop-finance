-- =========================================================================
-- ระบบสหกรณ์โรงเรียน — Supabase schema (LINE LIFF version)
-- รันไฟล์นี้ทั้งหมดใน Supabase Dashboard > SQL Editor
--
-- ตัวตนของผู้ใช้มาจาก LINE โดยตรง (LIFF getProfile) ไม่ได้ใช้ Supabase Auth
-- เลย ดังนั้น "id" ของผู้ใช้แต่ละคนในระบบนี้ = LINE userId (ข้อความ)
-- ไม่ใช่ uuid แบบเดิม
-- =========================================================================

-- ---------- users (โปรไฟล์ผู้ใช้ = คนที่เปิดแอปผ่าน LINE) ----------
create table if not exists public.users (
  id text primary key,              -- LINE userId เช่น "U4af4980629..."
  name text,                        -- เริ่มต้นจากชื่อ LINE, ผู้ใช้แก้ไขเองได้ทีหลัง
  picture_url text,                 -- รูปโปรไฟล์ LINE (sync ทุกครั้งที่เปิดแอป)
  role text not null default 'recorder' check (role in ('admin','recorder','viewer')),
  created_at timestamptz default now()
);

-- ---------- categories (หมวดหมู่) ----------
create table if not exists public.categories (
  id bigint generated always as identity primary key,
  name text not null,
  type text not null check (type in ('income','expense')),
  created_at timestamptz default now()
);

-- ---------- transactions (รายการรายรับ-รายจ่าย) ----------
create table if not exists public.transactions (
  id bigint generated always as identity primary key,
  date date not null default current_date,
  type text not null check (type in ('income','expense')),
  category_id bigint references public.categories(id),
  description text,
  amount numeric(12,2) not null check (amount >= 0),
  party text,               -- ผู้รับเงิน / ผู้จ่ายเงิน
  slip_url text,            -- ลิงก์รูปสลิป/ใบเสร็จใน storage
  created_by text references public.users(id) on delete set null,
  created_at timestamptz default now()
);

-- ---------- attachments (เผื่ออนาคต: แนบได้หลายไฟล์ต่อ 1 รายการ) ----------
create table if not exists public.attachments (
  id bigint generated always as identity primary key,
  transaction_id bigint references public.transactions(id) on delete cascade,
  file_url text not null,
  file_name text,
  created_at timestamptz default now()
);

create index if not exists idx_tx_date on public.transactions(date);
create index if not exists idx_tx_type on public.transactions(type);
create index if not exists idx_tx_category on public.transactions(category_id);
create index if not exists idx_tx_created_by on public.transactions(created_by);

-- =========================================================================
-- ROW LEVEL SECURITY
--
-- เลือกโหมด "เร็ว/ง่ายก่อน": ไม่มี Supabase Auth session ให้ตรวจสอบ (ตัวตน
-- มาจาก LIFF ฝั่ง client เท่านั้น) จึงเปิดให้ทุก request ที่ถือ anon key
-- อ่าน/เขียนได้ — สิทธิ์ (admin/recorder/viewer) ถูกบังคับใช้แค่ในหน้าเว็บ
-- (ปุ่ม/เมนูจะซ่อน/ปิดใช้งานตามสิทธิ์) ไม่ได้บังคับที่ระดับฐานข้อมูล
--
-- ข้อควรรู้: ใครก็ตามที่คัดลอก anon key จากหน้าเว็บไปเรียก Supabase REST
-- API ตรง ๆ จะสามารถอ่าน/แก้ไขข้อมูลทุกอย่างได้ ไม่ถูกกรองด้วยสิทธิ์ใด ๆ
-- เหมาะกับกลุ่มผู้ใช้ที่ไว้ใจกันในโรงเรียน ไม่เหมาะกับข้อมูลที่อ่อนไหวมาก
-- ถ้าต้องการปลอดภัยกว่านี้ในอนาคต ค่อยเพิ่มฟังก์ชันตรวจสอบ ID token จาก
-- LINE ฝั่งเซิร์ฟเวอร์ก่อนอนุญาตให้เขียนข้อมูล
-- =========================================================================
alter table public.users enable row level security;
alter table public.categories enable row level security;
alter table public.transactions enable row level security;
alter table public.attachments enable row level security;

create policy "open access users" on public.users for all using (true) with check (true);
create policy "open access categories" on public.categories for all using (true) with check (true);
create policy "open access transactions" on public.transactions for all using (true) with check (true);
create policy "open access attachments" on public.attachments for all using (true) with check (true);

-- =========================================================================
-- STORAGE — bucket for slip / receipt images (path: slips/YYYY/MM/filename)
-- =========================================================================
insert into storage.buckets (id, name, public)
values ('slips', 'slips', true)
on conflict (id) do nothing;

create policy "anyone can upload slips" on storage.objects
  for insert with check (bucket_id = 'slips');

create policy "anyone can view slips" on storage.objects
  for select using (bucket_id = 'slips');

-- =========================================================================
-- SEED DATA — default categories (from the spec)
-- =========================================================================
insert into public.categories (name, type) values
  ('ขายสินค้า', 'income'),
  ('ค่าบำรุง', 'income'),
  ('เงินสนับสนุน', 'income'),
  ('อื่นๆ (รายรับ)', 'income'),
  ('ซื้อสินค้า', 'expense'),
  ('วัสดุ', 'expense'),
  ('ค่าเดินทาง', 'expense'),
  ('ค่าไฟ', 'expense'),
  ('อื่นๆ (รายจ่าย)', 'expense')
on conflict do nothing;

-- =========================================================================
-- ผู้ดูแลระบบคนแรก: ไม่ต้องทำอะไรเพิ่ม!
-- คนแรกที่เปิดแอปผ่าน LINE จะกลายเป็น role='admin' โดยอัตโนมัติ
-- (เพราะตอนนั้นตาราง users ยังว่างอยู่) คนถัดไปจะได้ role='viewer' (ดูได้
-- อย่างเดียว) แล้วให้แอดมินไปเลื่อนสิทธิ์เป็น 'recorder' ให้บันทึกรายการได้
-- จากเมนู "ผู้ใช้งาน" ในเว็บ
-- =========================================================================

-- ถ้าเคยรัน schema เวอร์ชันก่อนหน้านี้ไปแล้ว (ที่ created_by ยังไม่มี
-- on delete set null) ให้รันคำสั่งนี้เพิ่มครั้งเดียว เพื่อให้ลบผู้ใช้งาน
-- ได้โดยไม่ติด foreign key และประวัติรายการเก่ายังอยู่ครบ:
--   alter table public.transactions drop constraint if exists transactions_created_by_fkey;
--   alter table public.transactions
--     add constraint transactions_created_by_fkey
--     foreign key (created_by) references public.users(id) on delete set null;

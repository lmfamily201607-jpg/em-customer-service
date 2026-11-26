-- รันครั้งเดียวใน Supabase (โปรเจกต์ของแอพ) → SQL Editor
-- ทำให้ Apps Script ส่งข้อมูลเคส DMS เข้าแอพได้ โดยเขียนได้เฉพาะ path 'audit/_dmsfeed/%' และต้องมีรหัสลับถูกต้อง
-- (ไม่ต้องใช้ service_role key และไม่ลบ/แก้ข้อมูลอื่นของแอพ)

create table if not exists public.dms_feed_secret (
  id int primary key default 1,
  secret text not null
);
alter table public.dms_feed_secret enable row level security;   -- ไม่มี policy = อ่านจากภายนอกไม่ได้

-- 1) เปลี่ยนข้อความในเครื่องหมายคำพูดเป็นรหัสลับยาวๆ ที่คุณตั้งเอง (จดไว้ใช้ในขั้นตอน Apps Script)
insert into public.dms_feed_secret (id, secret) values (1, 'เปลี่ยนเป็นรหัสลับยาวๆของคุณ')
on conflict (id) do update set secret = excluded.secret;

create or replace function public.push_dms_feed(p_secret text, p_path text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_path not like 'audit/_dmsfeed/%' then
    raise exception 'bad path';
  end if;
  if not exists (select 1 from public.dms_feed_secret where secret = p_secret) then
    raise exception 'unauthorized';
  end if;
  insert into public.em_docs (path, coll, data) values (p_path, 'audit', p_data)
  on conflict (path) do update set data = excluded.data;
end
$$;

revoke all on function public.push_dms_feed(text, text, jsonb) from public;
grant execute on function public.push_dms_feed(text, text, jsonb) to anon;

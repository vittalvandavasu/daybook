begin;
create schema tracker_private;
revoke all on schema tracker_private from public;
create table public.profiles (
 id uuid primary key references auth.users(id),
 name text unique not null check (name in ('Mallik','Vittal')),
 rate numeric(12,2) not null default 0 check(rate>=0),
 currency text not null default 'INR' check(currency ~ '^[A-Z]{3}$'),
 increment_seconds integer not null default 0 check(increment_seconds between 0 and 86400)
);
create table public.work_sessions (
 id uuid primary key,
 user_id uuid not null references public.profiles,
 timeline jsonb not null,
 ended_at timestamptz,
 details jsonb not null default '{}',
 rate numeric(12,2), currency text, increment_seconds integer,
 revision integer not null default 1
);
create unique index one_open_session on public.work_sessions(user_id) where ended_at is null;
create index session_dates on public.work_sessions(ended_at);
create table public.audit_logs (
 id bigint generated always as identity primary key,
 user_id uuid not null references public.profiles,
 session_id uuid references public.work_sessions,
 action text not null, reason text,
 before_data jsonb, after_data jsonb not null,
 at timestamptz not null default clock_timestamp()
);
create index audit_session on public.audit_logs(session_id,id);
create function tracker_private.provision() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if lower(new.email) in ('mallik.fico@gmail.com','vittalvandavasu16@gmail.com') then
 insert into public.profiles(id,name) values(new.id,case lower(new.email) when 'mallik.fico@gmail.com' then 'Mallik' else 'Vittal' end) on conflict(id) do nothing;
 end if;
 return new;
end $$;
create trigger tracker_account after insert or update of email on auth.users for each row execute function tracker_private.provision();
insert into public.profiles(id,name) select id,case lower(email) when 'mallik.fico@gmail.com' then 'Mallik' else 'Vittal' end from auth.users where lower(email) in ('mallik.fico@gmail.com','vittalvandavasu16@gmail.com');
create function tracker_private.member() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p join auth.users u on p.id=u.id where u.id=auth.uid() and lower(u.email)=case p.name when 'Mallik' then 'mallik.fico@gmail.com' else 'vittalvandavasu16@gmail.com' end)
$$;
alter table public.profiles enable row level security;
alter table public.work_sessions enable row level security;
alter table public.audit_logs enable row level security;
create policy members on public.profiles for select to authenticated using ((select tracker_private.member()));
create policy members on public.work_sessions for select to authenticated using ((select tracker_private.member()));
create policy members on public.audit_logs for select to authenticated using ((select tracker_private.member()));
revoke all on public.profiles,public.work_sessions,public.audit_logs from public,anon,authenticated;
grant select on public.profiles,public.work_sessions,public.audit_logs to authenticated;
create function tracker_private.actor() returns uuid language plpgsql stable set search_path='' as $$
begin
 if not tracker_private.member() then raise exception 'Workspace access denied'; end if;
 return auth.uid();
end $$;

create function public.act(p_action text,p_id uuid,p_revision integer,p_details jsonb default '{}') returns void language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=tracker_private.actor(); s public.work_sessions; p public.profiles;
 previous jsonb; stamp timestamptz; last_kind text; k text; v jsonb;
begin
 select * into strict p from public.profiles where id=actor for update;
 stamp:=date_trunc('second',clock_timestamp());
 if p_action='start' then
  if p_revision is distinct from 0 or jsonb_typeof(p_details) is distinct from 'object' then raise exception 'Invalid start request'; end if;
  for k,v in select * from jsonb_each(p_details) loop
   if k not in ('category','client','project','title','url','notes') or jsonb_typeof(v)<>'string' or length(v::text)>8002 then raise exception 'Invalid session details'; end if;
  end loop;
  if coalesce(p_details->>'category','') not in ('','Client call','Google Meet','Zoom','Telephone','Research','Design','Development','General work','Other') then raise exception 'Unknown activity'; end if;
  insert into public.work_sessions(id,user_id,timeline,details) values(p_id,actor,jsonb_build_array(jsonb_build_object('kind','work','at',stamp)),p_details) returning * into s;
 else
  select * into strict s from public.work_sessions where id=p_id and user_id=actor for update;
  if s.ended_at is not null or s.revision is distinct from p_revision then raise exception 'Session has changed. Refresh and try again.'; end if;
  previous:=to_jsonb(s);
  last_kind:=s.timeline->-1->>'kind';
  if p_action='stop' then
   update public.work_sessions set ended_at=stamp, rate=p.rate,currency=p.currency,increment_seconds=p.increment_seconds,revision=revision+1 where id=p_id returning * into s;
  elsif (p_action='break' and last_kind='work') or (p_action='resume' and last_kind='break') then
   update public.work_sessions set timeline=timeline||jsonb_build_object('kind',case p_action when 'break' then 'break' else 'work' end,'at',stamp),revision=revision+1 where id=p_id returning * into s;
  else raise exception 'Invalid clock transition'; end if;
 end if;
 insert into public.audit_logs(user_id,session_id,action,before_data,after_data) values(actor,p_id,p_action,previous,to_jsonb(s));
end $$;

create function public.set_rate(p_rate numeric,p_currency text,p_increment integer) returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=tracker_private.actor(); p public.profiles; previous jsonb;
begin
 select * into strict p from public.profiles where id=actor for update;
 previous:=to_jsonb(p);
 if p_rate='NaN'::numeric or p_rate<>round(p_rate,2) then raise exception 'Enter a valid rate with up to two decimals'; end if;
 update public.profiles set rate=p_rate,currency=upper(p_currency),increment_seconds=p_increment where id=actor returning * into p;
 insert into public.audit_logs(user_id,action,before_data,after_data) values(actor,'rate',previous,to_jsonb(p));
end $$;

create function public.correct_session(p_id uuid,p_revision integer,p_timeline jsonb,p_end timestamptz,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=tracker_private.actor(); p public.profiles; s public.work_sessions; previous jsonb; item jsonb;
 cleaned jsonb:='[]'; expected text:='work'; stamp timestamptz; prior timestamptz; first_at timestamptz; cutoff timestamptz;
begin
 select * into strict p from public.profiles where id=actor for update;
 select * into strict s from public.work_sessions where id=p_id and user_id=actor for update;
 cutoff:=date_trunc('second',clock_timestamp());
 if s.revision is distinct from p_revision then raise exception 'Session changed. Reload before editing.'; end if;
 if coalesce(length(trim(p_reason)),0) not between 1 and 4000 then raise exception 'A correction reason is required'; end if;
 if jsonb_typeof(p_timeline) is distinct from 'array' or jsonb_array_length(p_timeline)=0 then raise exception 'A work timeline is required'; end if;
 for item in select value from jsonb_array_elements(p_timeline) loop
  stamp:=date_trunc('second',(item->>'at')::timestamptz);
  if stamp is null or not isfinite(stamp) or stamp>cutoff or stamp<prior or item->>'kind' is distinct from expected then raise exception 'Check interval order, types and dates'; end if;
  first_at:=coalesce(first_at,stamp);
  cleaned:=cleaned||jsonb_build_object('kind',expected,'at',stamp);
  expected:=case expected when 'work' then 'break' else 'work' end;
  prior:=stamp;
 end loop;
 p_end:=date_trunc('second',p_end);
 if (s.ended_at is not null and p_end is null) or p_end>cutoff or p_end<prior then raise exception 'Invalid end time'; end if;
 if exists(select 1 from public.work_sessions other where other.user_id=actor and other.id<>p_id and first_at<coalesce(other.ended_at,'infinity') and (other.timeline->0->>'at')::timestamptz<coalesce(p_end,'infinity')) then raise exception 'Overlaps another session'; end if;
 previous:=to_jsonb(s);
 update public.work_sessions set timeline=cleaned,ended_at=p_end,revision=revision+1,
 rate=case when p_end is not null then coalesce(rate,p.rate) end,
 currency=case when p_end is not null then coalesce(currency,p.currency) end,
 increment_seconds=case when p_end is not null then coalesce(increment_seconds,p.increment_seconds) end where id=p_id returning * into s;
 insert into public.audit_logs(user_id,session_id,action,reason,before_data,after_data) values(actor,p_id,'correction',trim(p_reason),previous,to_jsonb(s));
end $$;
create function public.snapshot(p_from date,p_to date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=tracker_private.actor(); cutoff timestamptz:=date_trunc('second',statement_timestamp()); answer jsonb;
begin
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>3660 then raise exception 'Select a date range of up to ten years'; end if;
 with bounds as (
 select p_from::timestamp at time zone 'Asia/Kolkata' as lo,(p_to+1)::timestamp at time zone 'Asia/Kolkata' as hi
 ), selected as (
 select s.id,s.user_id,s.details,s.timeline,s.ended_at,s.revision,coalesce(s.rate,p.rate) rate,
 coalesce(s.currency,p.currency) currency,coalesce(s.increment_seconds,p.increment_seconds) inc
 from public.work_sessions s join public.profiles p on p.id=s.user_id cross join bounds b
 where s.ended_at is null or (s.ended_at>=b.lo and (s.timeline->0->>'at')::timestamptz<b.hi)
 ), intervals as (
 select s.id,t.item->>'kind' kind,(t.item->>'at')::timestamptz as a,
 lead((t.item->>'at')::timestamptz,1,coalesce(s.ended_at,cutoff)) over(partition by s.id order by t.seq) as z
 from selected s cross join lateral jsonb_array_elements(s.timeline) with ordinality t(item,seq)
 ), totals as (
 select id,coalesce(sum(extract(epoch from z-a)::bigint) filter(where kind='work'),0) w,
 coalesce(sum(extract(epoch from z-a)::bigint) filter(where kind='break'),0) b from intervals group by id
 ), billed as (
 select s.*,t.w,t.b,case when s.ended_at is not null and inc>0 then ceil(w/inc)*inc else w end bill
 from selected s join totals t using(id)
 ), calendar as (
 select p_from+n as day,(p_from+n)::timestamp at time zone 'Asia/Kolkata' lo,(p_from+n+1)::timestamp at time zone 'Asia/Kolkata' hi
 from generate_series(0,p_to-p_from) n
 ), daily as (
 select s.id,c.day,s.ended_at>=c.lo and s.ended_at<c.hi closed,
 coalesce(sum(greatest(0,extract(epoch from least(i.z,c.hi)-greatest(i.a,c.lo)))) filter(where i.kind='work'),0)::bigint w,
 coalesce(sum(greatest(0,extract(epoch from least(i.z,c.hi)-greatest(i.a,c.lo)))) filter(where i.kind='break'),0)::bigint b,
 coalesce(sum(greatest(0,extract(epoch from least(i.z,c.lo)-i.a))) filter(where i.kind='work'),0)::bigint prior_w
 from billed s join calendar c on (s.timeline->0->>'at')::timestamptz<c.hi and coalesce(s.ended_at,cutoff)>=c.lo
 join intervals i on i.id=s.id group by s.id,c.day,c.lo,c.hi,s.ended_at
 ), slices as (
 select d.*,s.user_id,s.currency,s.rate,s.details,d.w+case when closed then s.bill-s.w else 0 end bill from daily d join billed s using(id)
 )
 select jsonb_build_object('now',cutoff,'profiles',(select jsonb_agg(to_jsonb(p) order by p.name) from public.profiles p),
 'sessions',coalesce((select jsonb_agg((to_jsonb(s)-'w'-'b'-'bill'-'inc')||jsonb_build_object('increment_seconds',inc,'work_seconds',w,'break_seconds',b,'billable_seconds',bill,'amount',round(bill*rate/3600,2)) order by (timeline->0->>'at')::timestamptz desc) from billed s),'[]'),
 'days',coalesce((select jsonb_agg(jsonb_build_object('day',day,'session_id',id,'user_id',user_id,'project',details->>'project','client',details->>'client','work_seconds',w,'break_seconds',b,'billable_seconds',bill,'currency',currency,'amount',round((prior_w+bill)*rate/3600,2)-round(prior_w*rate/3600,2),'completed',coalesce(closed,false)) order by day desc) from slices),'[]'),
 'audit',coalesce((select jsonb_agg(to_jsonb(l) order by l.id desc) from public.audit_logs l join selected s on l.session_id=s.id where action='correction'),'[]')) into answer;
 return answer;
end $$;
revoke all on all functions in schema tracker_private from public,anon,authenticated;
grant usage on schema tracker_private to authenticated;
grant execute on function tracker_private.member() to authenticated;
revoke all on function public.act(text,uuid,integer,jsonb),public.correct_session(uuid,integer,jsonb,timestamptz,text),public.set_rate(numeric,text,integer),public.snapshot(date,date) from public,anon,authenticated;
grant execute on function public.act(text,uuid,integer,jsonb),public.correct_session(uuid,integer,jsonb,timestamptz,text),public.set_rate(numeric,text,integer),public.snapshot(date,date) to authenticated;
alter publication supabase_realtime add table public.profiles,public.work_sessions;
commit;


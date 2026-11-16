-- Small and home-based printers: a fact for pickup arranged ahead (porch pickup, by appointment),
-- and the suburbs and nearby towns where many of them work, added to each metro's city list.
-- seed.sql carries the same rows for a fresh database; on an existing one these statements add them.

insert into public.fact_defs (dataset_id, key, label, value_type, fact_group, sort)
select d.id, 'pickup_by_appointment', 'Pickup by arrangement', 'boolean', 'pickup', 55
  from public.datasets d where d.slug = 'makers'
on conflict (dataset_id, key) do nothing;

update public.metros m
   set cities = m.cities || array(select c from unnest(v.extra) c where not (c = any (m.cities)))
  from public.datasets d,
       (values ('buffalo', array['Elma','East Aurora','Lancaster','Depew','Kenmore','Grand Island','Clarence',
                                 'Alden','Eden','Springville','Wheatfield','Lewiston']),
               ('tampa-bay', array['Lutz','Seminole','Pinellas Park','Dunedin','Tarpon Springs','Valrico',
                                   'Port Richey','Holiday','Oldsmar','Safety Harbor','Apollo Beach','Ruskin',
                                   'Seffner','Odessa','Zephyrhills','Spring Hill','Hudson','Temple Terrace',
                                   'Sun City Center'])) as v(slug, extra)
 where d.slug = 'makers' and m.dataset_id = d.id and m.slug = v.slug;

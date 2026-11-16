-- Seed for the "makers" dataset. Safe to run more than once.
-- Listings are NOT seeded: every listing comes from a real check (docs/VERIFICATION.md).

insert into public.datasets (slug, name) values ('makers', 'Local makers')
on conflict (slug) do nothing;

insert into public.capabilities (dataset_id, slug, name)
select d.id, v.slug, v.name
  from public.datasets d,
       (values ('dtf', 'DTF transfers'),
               ('uv-dtf', 'UV DTF'),
               ('laser', 'Laser engraving and cutting'),
               ('sublimation', 'Sublimation'),
               ('embroidery', 'Embroidery'),
               ('blanks', 'Blanks on site'),
               ('3d-printing', '3D printing')) as v(slug, name)
 where d.slug = 'makers'
on conflict (dataset_id, slug) do nothing;

insert into public.metros (dataset_id, slug, name, state, cities)
select d.id, v.slug, v.name, v.state, v.cities
  from public.datasets d,
       (values ('tampa-bay', 'Tampa Bay', 'FL',
                array['Tampa','St. Petersburg','Clearwater','Brandon','Riverview','Wesley Chapel','Land O'' Lakes','Largo','Palm Harbor','New Port Richey','Plant City','Lutz','Seminole','Pinellas Park','Dunedin','Tarpon Springs','Valrico','Port Richey','Holiday','Oldsmar','Safety Harbor','Apollo Beach','Ruskin','Seffner','Odessa','Zephyrhills','Spring Hill','Hudson','Temple Terrace','Sun City Center']),
               ('buffalo', 'Buffalo', 'NY',
                array['Buffalo','Tonawanda','North Tonawanda','Amherst','Williamsville','Cheektowaga','West Seneca','Lackawanna','Hamburg','Orchard Park','Niagara Falls','Lockport','Elma','East Aurora','Lancaster','Depew','Kenmore','Grand Island','Clarence','Alden','Eden','Springville','Wheatfield','Lewiston']),
               ('houston', 'Houston', 'TX',
                array['Houston','Katy','Sugar Land','The Woodlands','Spring','Cypress','Pearland','Pasadena','Humble','Baytown','League City','Missouri City','Conroe','Tomball','Friendswood','Richmond','Rosenberg','Kingwood','Stafford','Bellaire','Channelview','La Porte','Webster','Fulshear','Magnolia','Seabrook','Kemah','Dickinson','Texas City','Galveston','Alvin','Manvel','Deer Park','Atascocita','Porter','New Caney','Montgomery','Hockley','Waller','Sealy']),
               ('atlanta', 'Atlanta', 'GA',
                array['Atlanta','Marietta','Alpharetta','Roswell','Sandy Springs','Decatur','Lawrenceville','Duluth','Kennesaw','Smyrna','Norcross','Peachtree City','Stone Mountain','Snellville','Buford','Cumming','Douglasville','McDonough','Stockbridge','Conyers','Johns Creek','Dunwoody','Tucker','Lithonia','Newnan','Woodstock','Canton','Acworth','Fayetteville','Covington','Suwanee','Loganville','Dallas','Hiram','Powder Springs','Austell','Mableton','East Point','College Park','Union City','Fairburn','Riverdale','Jonesboro','Hampton','Locust Grove','Lilburn','Dacula','Grayson','Cartersville','Villa Rica','Carrollton','Monroe']),
               ('dallas-fort-worth', 'Dallas-Fort Worth', 'TX',
                array['Dallas','Fort Worth','Arlington','Plano','Irving','Garland','Frisco','McKinney','Grand Prairie','Mesquite','Denton','Carrollton','Richardson','Lewisville','Allen','Flower Mound','Mansfield','Rowlett','Euless','Bedford','Grapevine','Keller','North Richland Hills','Burleson','Cedar Hill','DeSoto','Wylie','Little Elm','The Colony','Rockwall','Prosper','Weatherford','Haltom City','Hurst','Coppell','Addison','Farmers Branch','Duncanville','Lancaster','Forney','Midlothian','Waxahachie','Cleburne','Saginaw','Azle','Southlake','Colleyville','Sachse','Murphy','Anna','Celina','Princeton','Royse City','Terrell','Crowley','Benbrook','Granbury','Corinth','Highland Village','Aubrey'])
       ) as v(slug, name, state, cities)
 where d.slug = 'makers'
on conflict (dataset_id, slug) do nothing;

insert into public.fact_defs (dataset_id, key, label, value_type, fact_group, sort)
select d.id, v.key, v.label, v.value_type, v.fact_group, v.sort
  from public.datasets d,
       (values
         ('hours',                        'Opening hours',                          'hours',   'general', 10),
         ('ships',                        'Ships orders',                           'boolean', 'general', 20),
         ('pickup_walk_in',               'Walk-in pickup',                         'boolean', 'pickup',  30),
         ('pickup_after_hours',           'Evening or weekend pickup',              'boolean', 'pickup',  40),
         ('pickup_locker_24_7',           '24/7 pickup box',                        'boolean', 'pickup',  50),
         ('pickup_by_appointment',        'Pickup by arrangement',                  'boolean', 'pickup',  55),
         ('dtf_same_day_cutoff',          'Same-day DTF order cutoff',              'time',    'dtf',     60),
         ('dtf_price_per_foot_usd',       'DTF price per linear foot (USD)',        'number',  'dtf',     70),
         ('dtf_price_note',               'DTF pricing',                            'text',    'dtf',     80),
         ('dtf_max_width_in',             'Max DTF sheet width (inches)',           'number',  'dtf',     90),
         ('dtf_file_requirements',        'DTF file requirements',                  'text',    'dtf',    100),
         ('laser_types',                  'Laser types',                            'text',    'laser',  110),
         ('laser_materials',              'Materials engraved or cut',              'text',    'laser',  120),
         ('laser_customer_items',         'Engraves items you bring in',            'boolean', 'laser',  130),
         ('laser_turnaround_note',        'Typical laser turnaround',               'text',    'laser',  140),
         ('laser_price_note',             'Laser pricing',                          'text',    'laser',  150),
         ('laser_min_order_note',         'Laser minimum order',                    'text',    'laser',  160),
         ('sublimation_products_note',    'Sublimation products',                   'text',    'sublimation', 170),
         ('blanks_on_site',               'Stocks blanks on site',                  'boolean', 'blanks', 180),
         ('blanks_brands_note',           'Blank brands stocked',                   'text',    'blanks', 190)
       ) as v(key, label, value_type, fact_group, sort)
 where d.slug = 'makers'
on conflict (dataset_id, key) do nothing;

-- Published rates as read on 2026-11-15; confirm each on approval.
insert into public.affiliate_programs (slug, name, program_url, commission_note) values
  ('transfer-express',  'Transfer Express',  'https://transferexpress.com/affiliate-program',     '15% per sale, 30-day cookie'),
  ('dtfsheet',          'DTFSheet',          'https://dtfsheet.com/pages/dtfsheetaffiliate',      '15% per sale'),
  ('eazydtf',           'EazyDTF (Awin)',    'https://ui.awin.com/merchant-profile/98887',        '5% per sale, 30-day cookie'),
  ('heat-press-nation', 'Heat Press Nation', 'https://www.heatpressnation.com/pages/partners',    'Up to 10% sitewide, 30-day cookie'),
  ('xtool',             'xTool',             'https://www.xtool.com/pages/affiliate-program',     '4% to 6% on machines; varies by network'),
  ('jiffy',             'Jiffy',             'https://www.affpaying.com/jiffyaffiliates',         '$40 flat per new customer (from a listing site, unconfirmed)')
on conflict (slug) do nothing;

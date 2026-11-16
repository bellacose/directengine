-- Three more metros for the makers dataset: Houston, Atlanta and Dallas-Fort Worth.
-- seed.sql carries the same rows for a fresh database.
insert into public.metros (dataset_id, slug, name, state, cities)
select d.id, v.slug, v.name, v.state, v.cities
  from public.datasets d,
       (values
               ('houston', 'Houston', 'TX',
                array['Houston','Katy','Sugar Land','The Woodlands','Spring','Cypress','Pearland','Pasadena','Humble','Baytown','League City','Missouri City','Conroe','Tomball','Friendswood','Richmond','Rosenberg','Kingwood','Stafford','Bellaire','Channelview','La Porte','Webster','Fulshear','Magnolia','Seabrook','Kemah','Dickinson','Texas City','Galveston','Alvin','Manvel','Deer Park','Atascocita','Porter','New Caney','Montgomery','Hockley','Waller','Sealy']),
               ('atlanta', 'Atlanta', 'GA',
                array['Atlanta','Marietta','Alpharetta','Roswell','Sandy Springs','Decatur','Lawrenceville','Duluth','Kennesaw','Smyrna','Norcross','Peachtree City','Stone Mountain','Snellville','Buford','Cumming','Douglasville','McDonough','Stockbridge','Conyers','Johns Creek','Dunwoody','Tucker','Lithonia','Newnan','Woodstock','Canton','Acworth','Fayetteville','Covington','Suwanee','Loganville','Dallas','Hiram','Powder Springs','Austell','Mableton','East Point','College Park','Union City','Fairburn','Riverdale','Jonesboro','Hampton','Locust Grove','Lilburn','Dacula','Grayson','Cartersville','Villa Rica','Carrollton','Monroe']),
               ('dallas-fort-worth', 'Dallas-Fort Worth', 'TX',
                array['Dallas','Fort Worth','Arlington','Plano','Irving','Garland','Frisco','McKinney','Grand Prairie','Mesquite','Denton','Carrollton','Richardson','Lewisville','Allen','Flower Mound','Mansfield','Rowlett','Euless','Bedford','Grapevine','Keller','North Richland Hills','Burleson','Cedar Hill','DeSoto','Wylie','Little Elm','The Colony','Rockwall','Prosper','Weatherford','Haltom City','Hurst','Coppell','Addison','Farmers Branch','Duncanville','Lancaster','Forney','Midlothian','Waxahachie','Cleburne','Saginaw','Azle','Southlake','Colleyville','Sachse','Murphy','Anna','Celina','Princeton','Royse City','Terrell','Crowley','Benbrook','Granbury','Corinth','Highland Village','Aubrey'])
       ) as v(slug, name, state, cities)
 where d.slug = 'makers'
on conflict (dataset_id, slug) do nothing;

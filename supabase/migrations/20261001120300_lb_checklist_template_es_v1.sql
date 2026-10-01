-- LB-05: the initial Spanish wedding checklist template, version 1.
--
-- Source-controlled, deterministic reference data. Authored for
-- listalaboda.com; generic planning items only (no couple, venue, vendor or
-- personal data). Timings are editable planning suggestions, not rules.
--
-- relative_days: negative = days before the wedding, positive = after.
-- Items whose timing depends on circumstances carry no date.
--
-- Version 1 is immutable once shipped: content changes go in a new version.

insert into public.checklist_templates (key, version, locale, name, description)
values (
  'default-wedding-es',
  1,
  'es',
  'Lista general de boda',
  'Pendientes sugeridos para organizar una boda, de los primeros pasos a los días después.'
)
on conflict (key, version) do nothing;

insert into public.checklist_template_items (
  template_id, stable_key, sort_order, category, title, description, timing_mode, relative_days
)
select t.id, v.stable_key, v.sort_order, v.category::public.checklist_category, v.title,
       v.description, v.timing_mode::public.checklist_timing_mode, v.relative_days
from public.checklist_templates t
cross join (
  values
    -- Primeros pasos
    ('first_steps.budget', 10, 'first_steps', 'Definir el presupuesto aproximado',
     'Acuerden cuánto quieren invertir y cómo lo van a cubrir.', 'relative_to_wedding', -365),
    ('first_steps.guest_estimate', 20, 'first_steps', 'Estimar cuántas personas invitar',
     'Un número aproximado ayuda a elegir el lugar y a ajustar el presupuesto.', 'relative_to_wedding', -360),
    ('first_steps.style', 30, 'first_steps', 'Elegir el estilo de la boda',
     'Formal, campestre, íntima, en la playa… decidan juntos cómo la imaginan.', 'relative_to_wedding', -350),
    ('first_steps.date', 40, 'first_steps', 'Elegir la fecha de la boda',
     'Tengan a mano dos o tres opciones mientras consultan disponibilidad.', 'none', null),

    -- Lugar y fecha
    ('venue.research', 50, 'venue_and_date', 'Buscar y visitar lugares',
     'Comparen capacidad, ubicación, horarios y qué incluye cada opción.', 'relative_to_wedding', -330),
    ('venue.ceremony', 60, 'venue_and_date', 'Reservar el lugar de la ceremonia',
     null, 'relative_to_wedding', -300),
    ('venue.reception', 70, 'venue_and_date', 'Reservar el lugar de la recepción',
     null, 'relative_to_wedding', -300),
    ('venue.lodging', 80, 'venue_and_date', 'Buscar opciones de hospedaje para quienes viajan',
     null, 'relative_to_wedding', -180),

    -- Proveedores
    ('vendors.photography', 90, 'vendors', 'Contratar fotografía',
     'Revisen trabajos completos, no solo las mejores fotos.', 'relative_to_wedding', -270),
    ('vendors.video', 100, 'vendors', 'Decidir si habrá video',
     null, 'relative_to_wedding', -250),
    ('vendors.catering', 110, 'vendors', 'Contratar el servicio de comida',
     null, 'relative_to_wedding', -240),
    ('vendors.music', 120, 'vendors', 'Contratar la música',
     null, 'relative_to_wedding', -240),
    ('vendors.flowers', 130, 'vendors', 'Elegir flores y decoración',
     null, 'relative_to_wedding', -150),
    ('vendors.cake', 140, 'vendors', 'Elegir el pastel',
     null, 'relative_to_wedding', -90),
    ('vendors.transport', 150, 'vendors', 'Organizar el transporte del día',
     null, 'relative_to_wedding', -60),

    -- Atuendo
    ('attire.outfits', 160, 'attire', 'Elegir los atuendos de la pareja',
     null, 'relative_to_wedding', -240),
    ('attire.beauty', 170, 'attire', 'Reservar peinado y maquillaje',
     null, 'relative_to_wedding', -120),
    ('attire.rings', 180, 'attire', 'Comprar los anillos',
     null, 'relative_to_wedding', -90),
    ('attire.fittings', 190, 'attire', 'Agendar las pruebas de vestuario',
     null, 'relative_to_wedding', -60),

    -- Invitaciones
    ('invitations.list', 200, 'invitations', 'Preparar la lista de invitados',
     null, 'relative_to_wedding', -240),
    ('invitations.save_the_date', 210, 'invitations', 'Avisar la fecha a quienes vienen de lejos',
     null, 'relative_to_wedding', -180),
    ('invitations.design', 220, 'invitations', 'Diseñar las invitaciones',
     null, 'relative_to_wedding', -150),
    ('invitations.send', 230, 'invitations', 'Enviar las invitaciones',
     null, 'relative_to_wedding', -90),
    ('invitations.follow_up', 240, 'invitations', 'Dar seguimiento a las confirmaciones',
     null, 'relative_to_wedding', -30),

    -- Ceremonia
    ('ceremony.officiant', 250, 'ceremony', 'Elegir quién oficiará la ceremonia',
     null, 'relative_to_wedding', -270),
    ('ceremony.paperwork', 260, 'ceremony', 'Reunir los documentos para casarse',
     'Los requisitos cambian según el país y el tipo de ceremonia; consúltenlos con tiempo.',
     'relative_to_wedding', -120),
    ('ceremony.structure', 270, 'ceremony', 'Definir el orden de la ceremonia',
     null, 'relative_to_wedding', -60),
    ('ceremony.vows', 280, 'ceremony', 'Escribir los votos o elegir las lecturas',
     null, 'relative_to_wedding', -30),

    -- Recepción
    ('reception.menu', 290, 'reception', 'Elegir el menú',
     null, 'relative_to_wedding', -120),
    ('reception.layout', 300, 'reception', 'Definir la distribución de las mesas',
     null, 'relative_to_wedding', -30),
    ('reception.timeline', 310, 'reception', 'Armar el cronograma del día',
     'Desde la preparación hasta el cierre de la fiesta.', 'relative_to_wedding', -30),

    -- Preparativos finales
    ('final.vendor_check', 320, 'final_preparations', 'Confirmar horarios con cada proveedor',
     null, 'relative_to_wedding', -14),
    ('final.headcount', 330, 'final_preparations', 'Confirmar el número final de invitados',
     null, 'relative_to_wedding', -14),
    ('final.payments', 340, 'final_preparations', 'Preparar los pagos pendientes',
     null, 'relative_to_wedding', -7),
    ('final.day_kit', 350, 'final_preparations', 'Preparar un kit para el día',
     'Costurero, cargadores, pañuelos, curitas y algo para comer.', 'relative_to_wedding', -3),
    ('final.walkthrough', 360, 'final_preparations', 'Repasar el cronograma con quienes ayudan',
     null, 'relative_to_wedding', -2),

    -- Después de la boda
    ('after.returns', 370, 'after_wedding', 'Devolver lo alquilado',
     null, 'relative_to_wedding', 3),
    ('after.thanks', 380, 'after_wedding', 'Enviar agradecimientos',
     null, 'relative_to_wedding', 30)
) as v (stable_key, sort_order, category, title, description, timing_mode, relative_days)
where t.key = 'default-wedding-es' and t.version = 1
on conflict (template_id, stable_key) do nothing;

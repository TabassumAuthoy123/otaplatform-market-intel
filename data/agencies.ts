import type { Agency, CredentialState, Priority, SalesMode, SegmentCode } from './schema';
import { CLUSTERS } from './schema';

// ============================================================================
//  VERIFIED AGENCY DATASET
//  Names, addresses and phone numbers pulled from live public business
//  listings on 29 July 2026. Nothing invented.
//
//  Credential states are honest: only goFLY publishes its own numbers, so it
//  is the single 'verified' record. Everything else is 'inferred' (strong
//  public signal) or 'unknown' (ask on the call). Never present an inferred
//  credential to a client as a fact.
// ============================================================================

type Opts = Partial<
  Pick<
    Agency,
    | 'segmentSecondary' | 'exclusionReason' | 'caabLicence' | 'caabLicenceNo'
    | 'iata' | 'iataNo' | 'atab' | 'atabNo' | 'hajjLicence' | 'salesMode'
    | 'hasOwnPlatform' | 'reviewCount' | 'rating' | 'open247' | 'website'
    | 'facebook' | 'email' | 'altPhones' | 'suggestedTier'
  >
>;

let seq = 0;
function a(
  name: string,
  clusterId: string,
  address: string,
  phone: string | null,
  segment: SegmentCode,
  priority: Priority,
  signal: string,
  o: Opts = {}
): Agency {
  const cluster = CLUSTERS.find((c) => c.id === clusterId)!;
  seq += 1;
  return {
    id: `AG-${String(seq).padStart(3, '0')}`,
    name,
    clusterId,
    district: cluster.district,
    division: cluster.division,
    address,
    phone,
    altPhones: o.altPhones,
    website: o.website ?? null,
    facebook: o.facebook ?? null,
    email: o.email ?? null,
    segment,
    segmentSecondary: o.segmentSecondary,
    priority,
    exclusionReason: o.exclusionReason ?? null,
    // A publicly trading, publicly listed agency almost certainly holds the
    // Ministry licence — but 'inferred' until confirmed on the TAMS portal.
    caabLicence: o.caabLicence ?? 'inferred',
    caabLicenceNo: o.caabLicenceNo ?? null,
    iata: o.iata ?? 'unknown',
    iataNo: o.iataNo ?? null,
    atab: o.atab ?? 'unknown',
    atabNo: o.atabNo ?? null,
    hajjLicence: o.hajjLicence ?? 'unknown',
    salesMode: o.salesMode ?? 'manual',
    hasOwnPlatform: o.hasOwnPlatform ?? false,
    reviewCount: o.reviewCount ?? null,
    rating: o.rating ?? null,
    open247: o.open247 ?? false,
    signal,
    monthlyBookings: null,
    suggestedTier: o.suggestedTier ?? null,
    stage: priority === 'X' ? 'disqualified' : 'not_contacted',
    lastContactedAt: null,
    nextActionAt: null,
    ownerRep: priority === 'X' ? null : 'Tabassum Mustafa Authoy'
  };
}

const IATA_INF: Opts = { iata: 'inferred' };

export const AGENCIES: Agency[] = [
  // ===== PALTAN / BIJOYNAGAR ================================================
  a('Rodela International', 'paltan', 'Room 6/5-6, 6th Floor, Eastern View, D.I.T. Extension Road, 50 Naya Paltan, Dhaka 1000', '02-9345998', 'S3', 'A',
    'Publicly self-describes as Govt & IATA approved. Has issuing power, no storefront.',
    { ...IATA_INF, rating: 5.0, reviewCount: 4, suggestedTier: 'Growth' }),
  a('Sim Trade Global Tourism (Tims Group)', 'paltan', '4th Floor, 67 VIP Road, Dhaka 1000', '01322-891640', 'S1', 'A',
    'Runs a 24-hour desk for "parties or customers" — already serving sub-agents manually.',
    { segmentSecondary: 'S2', hajjLicence: 'inferred', salesMode: 'sub_agent', rating: 4.2, reviewCount: 61, open247: true, suggestedTier: 'Growth' }),
  a('Hajee Air', 'paltan', 'Suite W16/1,2,3, Level 15, Paltan China Town, Dhaka 1000', '01325-084863', 'S4', 'A',
    'Consolidator + IATA + corporate travel. Pitch the agent portal, not a starter package.',
    { ...IATA_INF, rating: 4.5, reviewCount: 54, open247: true, suggestedTier: 'Professional' }),
  a('Mims Travels & Tours Limited', 'paltan', '45 Shahid Syed Nazrul Islam Sarani, Tropicana Tower (2nd Floor), Dhaka 1000', '02-9550499', 'S1', 'A',
    'Landline only, US-diaspora repeat customers, no visible site. Fully offline.',
    { rating: 4.3, reviewCount: 12, suggestedTier: 'Growth' }),
  a('Azaan Travel Services', 'paltan', '87 Paltan Tower, Level 6, Room 605, Kulvert Road, Purana Paltan, Dhaka 1000', '01913-229025', 'S1', 'B',
    'Strong service reviews, zero web presence. Prime sub-agent profile.',
    { rating: 5.0, reviewCount: 12, suggestedTier: 'Starter' }),
  a('FLYBURJ Travels & Tourism Ltd', 'paltan', '2nd Floor, 144 DIT Avenue, Dhaka 1000', '01825-686231', 'S2', 'B',
    'Umrah visa processing plus air ticketing. Thin digital footprint.',
    { hajjLicence: 'inferred', rating: 4.6, reviewCount: 11, suggestedTier: 'Starter' }),
  a('Naria Travels and Tours', 'paltan', '13th Floor, Sky View Trade Valley, Dhaka 1000', '01772-944676', 'S1', 'B',
    'Package-heavy with international ground handling. Pitch the package builder.',
    { rating: 4.6, reviewCount: 29, suggestedTier: 'Starter' }),
  a('Glide Tours & Travels Ltd', 'paltan', 'VIP 19, Mosque Road, Dhaka 1000', '02-9345939', 'S1', 'B',
    'Landline-first listing — older established firm, likely fully offline.',
    { rating: 4.4, reviewCount: 5, suggestedTier: 'Starter' }),
  a('AIR BD Travel Service', 'paltan', 'Room 13/A, Floor 5, Suleman Plaza, 162 Shahid Syed Nazrul Islam Sarani, Dhaka 1000', '01726-919596', 'S1', 'B',
    'Open 24h but reviews cite slow phone response — a capacity problem automation fixes.',
    { rating: 3.8, reviewCount: 17, open247: true, suggestedTier: 'Starter' }),
  a('Best Fly International (Travels & Tours)', 'paltan', '56/1 Baitul View Tower, Purana Paltan, Dhaka 1000', '01675-615620', 'S1', 'C',
    'Multi-airline ticketing, modest scale. Qualify volume first.',
    { rating: 4.1, reviewCount: 16 }),
  a('Mojib Tours & Travels', 'paltan', 'Paltan China Town, 3rd Floor, Suite 4/33, 67/1 Naya Paltan, VIP Road, Dhaka 1000', '01711-716483', 'S1', 'C',
    'Very small digital footprint. Qualify booking volume on call one.',
    { rating: 5.0, reviewCount: 1 }),
  a('Al-Akhowan Travels & Tours', 'paltan', '30/A Naya Paltan, Sattara Centre, VIP Road, Hotel Victory, 9th Floor, Dhaka 1000', '01711-969291', 'S1', 'C',
    'Same building as ATAB and HAAB. Small — useful as a warm-up call to learn the building.',
    { rating: 5.0, reviewCount: 1 }),
  a('The Super Eastern Ltd (RL 501)', 'paltan', '67 Naya Paltan, City Heart Shopping Complex, 5th Floor, Suite 6, Dhaka 1000', '01939-861642', 'S6', 'C',
    'Carries a recruiting licence — combined manpower and travel. Only pitch if air volume is real.',
    { rating: 3.7, reviewCount: 6 }),

  // ===== MOTIJHEEL ==========================================================
  a('Union Travels Ltd', 'motijheel', '9/K Toyenbee Circular Road, Motijheel C/A, Dhaka 1000', '01967-605243', 'S3', 'A',
    'Reviews state it holds Hajj, Umrah AND IATA licences and issues all airlines directly. Best-fit profile on the entire list.',
    { segmentSecondary: 'S2', ...IATA_INF, hajjLicence: 'inferred', rating: 5.0, reviewCount: 23, suggestedTier: 'Professional' }),
  a('Heritage Air Express Ltd', 'motijheel', '104 Globe Chamber, Motijheel C/A, Dhaka 1000', '09612-112233', 'S3', 'A',
    'IATA-accredited, operating since 1998. Publicly noted as having a weaker online presence than newer agencies — the exact gap.',
    { ...IATA_INF, hajjLicence: 'inferred', rating: 4.4, reviewCount: 70, suggestedTier: 'Professional' }),
  a('Majestic Travel International', 'motijheel', 'Red Crescent House, 61 Motijheel Road, Dhaka 1000', '01873-172737', 'S3', 'A',
    'Reviews describe an IATA agent handling multi-country visa plus ancillaries. Corporate-leaning.',
    { ...IATA_INF, rating: 4.5, reviewCount: 11, suggestedTier: 'Growth' }),
  a('Muktir Sandhane Trade & Travel Ltd', 'motijheel', '3rd Floor, Bhuiyan Mansion, 06 Motijheel C/A, Dhaka 1000', '01732-077840', 'S1', 'B',
    'Consistently strong service reviews, no visible portal. Owner clearly cares about quality — receptive to a CX pitch.',
    { rating: 5.0, reviewCount: 44, suggestedTier: 'Growth' }),
  a('Islami Air Services (Hajj & Umrah)', 'motijheel', 'Baitul Haque, 78 Motijheel Road, Dhaka 1000', '01711-660624', 'S2', 'B',
    'Dedicated Hajj and Umrah operator with strong trust reviews.',
    { hajjLicence: 'inferred', rating: 5.0, reviewCount: 2, suggestedTier: 'Hajj' }),

  // ===== GULISTAN ===========================================================
  a('AZM TRIP', 'gulistan', 'Office 90, 4th Floor, Sundarban Square Super Market, Gulistan Road, Dhaka 1000', '01843-666642', 'S1', 'B',
    'Open 7 days, small, "reliable and trustworthy" reputation, no site.',
    { rating: 4.7, reviewCount: 3, suggestedTier: 'Starter' }),

  // ===== GULSHAN / BANANI ===================================================
  a('International Travel Corporation Ltd (ITC)', 'gulshan', 'Landmark Tower, 10th Floor, 12\u201314 Gulshan North Avenue, Dhaka 1212', '01766-194500', 'S3', 'A',
    'IATA since 1990 — one of the longest-running in the country. Dhaka + Chattogram offices. App booking is a known public weakness.',
    { ...IATA_INF, rating: 4.2, reviewCount: 128, suggestedTier: 'Professional' }),
  a('TALON Corporation Ltd', 'gulshan', 'House 11/B (4th Floor), Road 130, Gulshan, Dhaka 1212', '01909-112568', 'S3', 'A',
    'IATA, est. 2009. MICE and large group movements. Online booking interface publicly noted as underdeveloped.',
    { ...IATA_INF, rating: 4.4, reviewCount: 149, suggestedTier: 'Professional' }),
  a('Galaxy Travel International', 'gulshan', '2nd Floor, Taj Cassilina, 25 Gulshan Avenue, Dhaka 1212', '02222-262238', 'S3', 'A',
    'IATA, established 1972 — the oldest agency in Bangladesh. Government, enterprise and diplomatic accounts. Highest-prestige logo available.',
    { ...IATA_INF, rating: 4.0, reviewCount: 33, suggestedTier: 'Enterprise' }),
  a('MAAS Travel & Tours Ltd', 'gulshan', 'RM Centre (5th Floor), 101 Gulshan Avenue, Dhaka 1212', '02-8837484', 'S3', 'B',
    'Corporate accounts plus walk-in, multi-embassy visa handling. Landline-first, established.',
    { rating: 4.2, reviewCount: 75, suggestedTier: 'Growth' }),
  a('Air Confidence Travel Agents', 'gulshan', 'Level 4, NI Tower, Plot 01, Road 10, Banani, Dhaka 1213', '01907-473502', 'S1', 'B',
    'Professional mid-size agency in a corporate tower, no visible platform.',
    { rating: 4.6, reviewCount: 23, suggestedTier: 'Growth' }),
  a('FLYON Tours & Travels', 'gulshan', 'Level 3, 50 Habib Super Market, Dhaka 1212', '01613-517786', 'S1', 'B',
    'Small operation covering tickets, hotels and visa. No site.',
    { rating: 5.0, reviewCount: 4, suggestedTier: 'Starter' }),
  a('Galactic Tours & Travels', 'gulshan', 'House 1B, Road 126, Gulshan-1, Dhaka 1212', '01326-709397', 'S6', 'C',
    'Open 24h, very new listing. Greenfield.',
    { rating: 5.0, reviewCount: 2, open247: true }),
  a('Horizon Express Ltd', 'gulshan', 'Plot 60/D, Road 131, Flat 3 (2nd Floor), Gulshan South, Dhaka 1212', null, 'S1', 'C',
    'No phone in the public listing — walk-in or LinkedIn route. Modest digital footprint.',
    { rating: 4.4, reviewCount: 41 }),

  // ===== UTTARA =============================================================
  a('FlyTrek', 'uttara', 'House 26, Road 24, Sector 7, Uttara, Dhaka 1230', '01616-124565', 'S1', 'A',
    'Effectively 24/7, strong visa reputation (notably Thailand), high review volume, growth-minded owner. Likely early reference client.',
    { rating: 4.8, reviewCount: 147, open247: true, suggestedTier: 'Growth' }),
  a('Roaming Tours & Travels', 'uttara', 'Road 2, House 25, Sector 3, Uttara (behind Shopno Super Shop), Dhaka 1230', null, 'S1', 'A',
    'Acquires customers through Facebook posts — including from Sylhet — with no platform to convert them. Cleanest ICP match on the list. Approach via Facebook page.',
    { rating: 5.0, reviewCount: 18, suggestedTier: 'Growth' }),
  a('Zest Travel Shop', 'uttara', '31 Gareeb-e-Nawaz Avenue, Uttara, Dhaka 1230', '01797-979898', 'S1', 'A',
    'Multi-destination packages (Turkey, Nepal, Singapore, Malaysia, China visas). Run by a retired army officer — process-oriented, systems-friendly buyer.',
    { rating: 5.0, reviewCount: 84, suggestedTier: 'Growth' }),
  a('Soai Air International Travel', 'uttara', 'House 7, Sector 7, Road 16, Uttara, Dhaka 1230', '01997-836161', 'S1', 'A',
    'Perfect review score, open 7 days. Owner named repeatedly in reviews — single decision maker, fast cycle.',
    { rating: 5.0, reviewCount: 35, suggestedTier: 'Growth' }),
  a('IKRAR Tours and Travels', 'uttara', 'House 88, 75 Road No. 13, Uttara, Dhaka 1230', '01581-401877', 'S1', 'B',
    'Reviews reference delivering service "anywhere in Bangladesh" and an online service — already remote-selling. Open 7 days.',
    { rating: 5.0, reviewCount: 12, suggestedTier: 'Starter' }),
  a('Skylark Tours & Travels', 'uttara', 'House 15 (1st Floor), Sonargaon Janapath Road, Uttara, Dhaka 1230', '01764-434319', 'S1', 'B',
    'Real team with named reservation staff — multi-user roles and audit logging will resonate. Mixed reviews on staff conduct make the audit trail an easier sell.',
    { rating: 4.6, reviewCount: 52, suggestedTier: 'Growth' }),
  a('Best Travels Ltd', 'uttara', 'Rajlaxmi Complex, Lift 6, Uttara, Dhaka 1230', '09677-443333', 'S1', 'B',
    'Corporate hotline number suggests deliberate investment in professional presentation.',
    { rating: 4.9, reviewCount: 11, suggestedTier: 'Starter' }),
  a('Air Cloud Tours and Travels', 'uttara', 'Room 05, Level 6, HM Plaza, Uttara, Dhaka 1230', '01713-530011', 'S1', 'B',
    'Small-to-mid agency in a busy commercial complex. Qualify volume on call one.',
    { rating: 5.0, reviewCount: 5 }),
  a('Uttara Tours & Travels', 'uttara', 'House 34, Road 01, Uttara, Dhaka 1230', '01746-552755', 'S1', 'C',
    'Small local agency, thin online presence. Volume qualification essential.',
    { rating: 4.8, reviewCount: 16 }),
  a('Air Ticket Uttara', 'uttara', 'Begum Zahura Market, Plot 15/C, Road 12, Uttara, Dhaka 1230', '01600-318136', 'S6', 'C',
    'Retail counter model. Likely below the viability threshold — qualify hard.',
    { rating: 4.5, reviewCount: 4 }),

  // ===== DHANMONDI / MOHAMMADPUR / SHYAMOLI / LALMATIA ======================
  a('Air Ticket Point', 'dhanmondi', 'Riverview, Road 11, Dhanmondi, Dhaka 1209', '01315-403803', 'S1', 'A',
    'Operates 24/7, competes explicitly on price transparency and rapid rebooking. Volume-driven, efficiency-minded owner — automation ROI is the pitch.',
    { rating: 5.0, reviewCount: 15, open247: true, suggestedTier: 'Growth' }),
  a('Buy Air Ticket', 'dhanmondi', 'Flat 4/A, 43/2 College Area, adjacent BEL Tower (Beximco), Dhaka 1205', '01613-336662', 'S1', 'A',
    'Open 24 hours; reviews describe answering calls at 3 a.m. Selling digitally with brute manual effort. Automation pitch lands hard.',
    { rating: 4.7, reviewCount: 50, open247: true, suggestedTier: 'Growth' }),
  a('SureTrip', 'dhanmondi', 'Level 7, Plot 18, Ring Road, Dhaka 1207', '01894-692526', 'S1', 'A',
    'Fast-growing, waives void fees, international long-haul routes (Helsinki, Japan, Cyprus). No platform.',
    { rating: 5.0, reviewCount: 4, suggestedTier: 'Growth' }),
  a('On Air Tours & Travels', 'dhanmondi', 'Shop 207, 1st Floor, Shyamoli Blossom Market, 38/3\u201338/4 Ring Road, Dhaka 1207', '01309-169030', 'S1', 'A',
    'Market-shop agency doing domestic and international ticketing plus visa. No site.',
    { rating: 4.9, reviewCount: 17, suggestedTier: 'Starter' }),
  a('Salma Air Travels', 'dhanmondi', '1/1 Nest Osmium Tower, Block E, Satmasjid Road, Dhaka 1207', '01946-881177', 'S2', 'A',
    'Heavy KSA and Hajj passenger traffic with a strong repeat base. Hajj module candidate.',
    { hajjLicence: 'inferred', rating: 4.9, reviewCount: 35, suggestedTier: 'Hajj' }),
  a('Ticketwalabd', 'dhanmondi', 'Plot 7, Road No. 1, Dhaka 1207', '01816-462243', 'S1', 'B',
    'Newer and digitally aware — reviews written in Banglish suggest a young owner. Fast decision.',
    { rating: 5.0, reviewCount: 7, suggestedTier: 'Starter' }),
  a('7 Air Travels Ltd', 'dhanmondi', 'Lalmatia 7 Shopping Center, Lalmatia Aarong Road, Dhaka 1207', '09611-900161', 'S1', 'B',
    'Corporate hotline, praised specifically for refund handling. Professionalised operation.',
    { rating: 4.4, reviewCount: 17, suggestedTier: 'Growth' }),
  a('Fly Aura', 'dhanmondi', '64 Janata Housing Road, Dhaka 1207', '01712-800238', 'S1', 'B',
    'Reviews cite 31 years in the trade. Open 24h, zero digital presence. Deep experience, no system.',
    { rating: 5.0, reviewCount: 12, open247: true, suggestedTier: 'Growth' }),
  a('SUMIN Air Travels', 'dhanmondi', 'Shop 30, beside Lalmatia Shopping Complex, Lalmatia Aarong Road, Dhaka 1207', '01844-674442', 'S1', 'B',
    'Small ticketing agent with high service ratings.',
    { rating: 4.5, reviewCount: 8, suggestedTier: 'Starter' }),
  a('Merlin Tours & Travel', 'dhanmondi', 'House 2, Orchid Plaza, Road 28 (old), Mirpur Road, Dhanmondi, Dhaka 1209', '01997-770000', 'S1', 'B',
    'Established retail presence. Some negative reviews on client handling — CRM and audit trail are the angle.',
    { rating: 4.2, reviewCount: 44, suggestedTier: 'Growth' }),
  a('airZain', 'dhanmondi', '319, 2nd Floor, BRTC Bus Stand Super Market, Satmasjid Road, Dhaka 1207', '01844-232205', 'S6', 'C',
    'Brand-new listing. Greenfield.',
    { rating: 5.0, reviewCount: 1 }),
  a('Keya Tours and Travels', 'dhanmondi', '3rd Floor, Momtaz Plaza, House 7, Road No. 4, Dhanmondi, Dhaka 1205', '01755-542533', 'S1', 'C',
    'Packages plus agent banking. Mixed model — qualify what share is air ticketing.',
    { rating: 4.5, reviewCount: 19 }),
  a('Air Ticket', 'dhanmondi', '1/3 Popular Housing, Dhaka 1216', null, 'S6', 'C',
    'Open 24h, minimal public information. Qualify by phone.',
    { rating: 4.3, reviewCount: 4, open247: true }),

  // ===== BANASREE / RAMPURA / BADDA =========================================
  a('NEC Travels', 'banasree', 'House 31, Block A, Road 2, Banasree Main Road, Dhaka 1219', '01319-992605', 'S1', 'A',
    'Reviews explicitly describe WhatsApp-based updates and quoting, open 24h. Textbook target — this is the profile the product was built for.',
    { salesMode: 'manual', rating: 4.8, reviewCount: 8, open247: true, suggestedTier: 'Growth' }),
  a('Global Connection Tours and Travels', 'banasree', 'House 4, Block F, Main Road, Banasree, Dhaka 1219', '01745-995788', 'S1', 'A',
    'Solid review base across ticketing and abroad services. No platform.',
    { rating: 4.8, reviewCount: 34, suggestedTier: 'Growth' }),
  a('TR3K LTD', 'banasree', 'House 14, Block B, Lift 3, Banasree Main Road, Dhaka 1219', '01713-032261', 'S1', 'A',
    'Visa plus ticket plus hotel, modern branding and positioning — but no booking engine behind it.',
    { rating: 5.0, reviewCount: 10, suggestedTier: 'Growth' }),
  a('Jamia Tours & Travels', 'banasree', 'Level 3, E-Housing 1, Block G, Road 7, Dhaka 1219', '01839-931673', 'S1', 'B',
    'Price-led, community and Eid traffic, fully manual.',
    { rating: 5.0, reviewCount: 4, suggestedTier: 'Starter' }),
  a('Adil Travel Agency', 'banasree', 'House 3, Block H, Main Road, Banasree, Rampura, Dhaka 1219', '01621-434676', 'S6', 'B',
    'Work-permit visa focus (UAE corridor) — different workflow. Qualify air volume.',
    { rating: 5.0, reviewCount: 3 }),
  a('Wings Fly Tours And Travels', 'banasree', 'A7\u2013A8 Banasree Main Road, Dhaka 1212', '01307-448268', 'S6', 'B',
    'Also runs a training centre — their graduates are additional newly-licensed leads.',
    { rating: 4.5, reviewCount: 4 }),
  a('Bihongo Tour & Travels', 'banasree', '4 Road No. 4, Dhaka 1219', '01768-370000', 'S6', 'C',
    'Very small, very long opening hours.',
    { rating: 5.0, reviewCount: 1 }),

  // ===== HAJJ & UMRAH (DHAKA) ===============================================
  a('Zamzam Travels BD', 'hajj-dhaka', '9 Purana Paltan, CPDL Ahmed Forum, 8th Floor, Dhaka 1205', '01733-391826', 'S2', 'A',
    'Repeat pilgrims since 2018, named ground staff in Makkah and Madinah. Real scale, real complexity, real reputation to protect. Best Hajj target on the list.',
    { hajjLicence: 'inferred', rating: 4.6, reviewCount: 89, suggestedTier: 'Hajj' }),
  a('Jetway Hajj Umrah Group', 'hajj-dhaka', '4th Floor, Noakhali Tower, 55/B Purana Paltan, Dhaka 1000', '01795-827700', 'S2', 'A',
    'Handles inbound pilgrims from the USA and Canada as well as Bangladesh, customises packages, owner personally involved. International coordination = strong system need.',
    { hajjLicence: 'inferred', rating: 4.4, reviewCount: 132, suggestedTier: 'Hajj' }),
  a('Holy Tourism Bangladesh', 'hajj-dhaka', '2/2/C Paltan, Culvert Road, Dhaka 1213', '01844-509199', 'S2', 'A',
    'Umrah-focused, owner-led, active review base including a serious payment dispute — document tracking and written policy answer that risk directly.',
    { hajjLicence: 'inferred', rating: 4.6, reviewCount: 55, suggestedTier: 'Hajj' }),
  a('Hajj Umrah Bangladesh', 'hajj-dhaka', '26, 1st Floor, Pritom Bhaban, 215 Shahid Syed Nazrul Islam Sarani, Dhaka 1000', '01519-888444', 'S2', 'B',
    'Affordable-package positioning — lead with cost per pilgrim, not premium features.',
    { hajjLicence: 'inferred', rating: 4.6, reviewCount: 19, suggestedTier: 'Hajj' }),
  a('Hawa Tourism', 'hajj-dhaka', '3/3C, 183, 2nd Floor, Bijoy Nagar Road, Dhaka 1000', '01999-800026', 'S2', 'B',
    'Small Umrah operator with training-related activity. Qualify pilgrim numbers per season.',
    { hajjLicence: 'inferred', rating: 5.0, reviewCount: 15, suggestedTier: 'Starter' }),
  a('Hajj Umrah Expert', 'hajj-dhaka', 'Level 7, Akram Tower, opposite the water tank, Bijoynagar, Dhaka 1000', null, 'S2', 'B',
    'Small, strongly reviewed, CEO named personally in every review — single decision maker, fast if the fit is there. Approach via Facebook.',
    { hajjLicence: 'inferred', rating: 5.0, reviewCount: 4, suggestedTier: 'Starter' }),

  // ===== CHATTOGRAM =========================================================
  a('Al Siraj Travels', 'chattogram', 'Hotel Agrabad Arcade, Chattogram 4100', '01715-612300', 'S5', 'A',
    'Offices in both Chattogram and Dhaka — multi-branch, so roles, permissions and multi-tenant story land well. Best Chattogram target.',
    { segmentSecondary: 'S1', rating: 4.9, reviewCount: 9, suggestedTier: 'Growth' }),
  a('Rafy\u2013National Travels', 'chattogram', 'Hotel Agrabad, Ground Floor (entrance side), beside US-Bangla Airlines, Chattogram 4100', null, 'S5', 'A',
    'Very high review volume across ticketing, visa support and money exchange, operating 24/7. Substantial multi-service operation. Visit in person.',
    { rating: 5.0, reviewCount: 801, open247: true, suggestedTier: 'Growth' }),
  a('Blue-Dream Tours & Travels Ltd', 'chattogram', 'Makkah Madina Trade Centre, Agrabad, Chattogram 4000', '01911-038122', 'S5', 'B',
    'Package and resort heavy with solid review volume, open 7 days. Emphasise package builder and B2C storefront.',
    { rating: 4.3, reviewCount: 142, suggestedTier: 'Growth' }),
  a('S.M. Tours & Travels', 'chattogram', '69 Agrabad C/A, Chattogram 4100', '01715-608300', 'S5', 'B',
    'Established Agrabad agency with minimal digital footprint. Greenfield.',
    { rating: 5.0, reviewCount: 2, suggestedTier: 'Starter' }),
  a('H A Tours & Travels', 'chattogram', 'Sabdar Ali Road, Chattogram 4100', '01766-270500', 'S5', 'C',
    'Small local agency. Qualify volume before travelling.',
    { rating: 5.0, reviewCount: 1 }),

  // ===== SYLHET =============================================================
  a('Atiya Travels', 'sylhet', '104\u2013109, Ground Floor, RB Complex, Zindabazar, Sylhet 3111', '01711-382113', 'S5', 'A',
    'Strong reviews on international ticketing (Canada, France, study-abroad) plus Umrah. Owner named throughout — relationship sale to one decision maker. Best Sylhet entry point.',
    { segmentSecondary: 'S2', rating: 4.8, reviewCount: 113, suggestedTier: 'Growth' }),
  a('Sarah Travel Expert', 'sylhet', '331 Surma Tower, Level 4 (Lift 3), Court Point, VIP Road, Sylhet 3100', '01737-371731', 'S5', 'A',
    'Perfect review score, open late 7 days, visa-heavy including Dubai. Described as doers rather than talkers — pragmatic efficiency buyer.',
    { rating: 5.0, reviewCount: 47, suggestedTier: 'Growth' }),
  a('Lotif Travels Private Limited (Zindabazar)', 'sylhet', '119\u2013124, Ground Floor, RB Complex, Zindabazar, Sylhet 3100', '01711-330729', 'S2', 'A',
    'Among the oldest in the Sylhet division, multi-branch, heavy Hajj and Umrah including UK-origin pilgrims. Significant scale; hotel-mismatch complaints make the transparency pitch directly relevant.',
    { segmentSecondary: 'S5', hajjLicence: 'inferred', rating: 4.1, reviewCount: 145, suggestedTier: 'Hajj' }),
  a('Al Mansur Air Service Ltd', 'sylhet', 'Nasrin Garden, 50/1 Polashi Kazi Elias Road, Sylhet 3100', '01737-847728', 'S5', 'B',
    'One of the older Sylhet houses — ticketing, Umrah, Hajj. Established and offline.',
    { hajjLicence: 'inferred', rating: 4.2, reviewCount: 35, suggestedTier: 'Growth' }),
  a('Success Mentors', 'sylhet', '518\u2013520, 4th Floor, West World Shopping City, Sylhet 3100', '01716-748363', 'S5', 'B',
    'Education consultancy plus air ticketing, 24/7, student-travel heavy. Intake seasons create real peaks that automation solves.',
    { rating: 5.0, reviewCount: 25, open247: true, suggestedTier: 'Growth' }),
  a('Khandakar Travel Agency', 'sylhet', 'Suite 2/3, 1st Floor, Liyakot Bhaban, Jallarpar, Zindabazar (near Pach Bhai Restaurant), Sylhet 3100', '01888-405065', 'S5', 'B',
    'Small with a high-integrity reputation across visa, student and ticketing. Owner-operated, fast decision.',
    { rating: 5.0, reviewCount: 5, suggestedTier: 'Starter' }),
  a('Sky Air Travels', 'sylhet', '5 Overseas Centre, Sylhet 3100', '01711-125451', 'S5', 'C',
    'Small general agency, thin footprint.',
    { rating: 3.8, reviewCount: 9 }),
  a('Sylhet Air Services', 'sylhet', 'Jail Road, Sylhet 3100', '01711-232120', 'S5', 'C',
    'Very small listing, minimal public information. Qualify by phone before any investment.',
    { rating: 4.3, reviewCount: 4 }),

  // ===== NARAYANGANJ ========================================================
  a('Jagat Vromon Travels', 'narayanganj', 'Club Market, 95 Bangabandhu Road, Narayanganj 1400', '01927-884884', 'S5', 'A',
    '47 reviews all citing lowest fares, open 7 days. Volume operation with no platform. Softifybd has a Narayanganj office — easiest field visit on the list.',
    { rating: 5.0, reviewCount: 47, suggestedTier: 'Growth' }),
  a('Narayanganj Tours & Travels', 'narayanganj', 'Sufiya Plaza, 123 Bangabandhu Extended Road, Narayanganj 1400', '01714-070732', 'S2', 'A',
    'Locally reputed Hajj and Umrah agency.',
    { hajjLicence: 'inferred', rating: 4.6, reviewCount: 13, suggestedTier: 'Hajj' }),
  a('Chaity Tours & Travels', 'narayanganj', '95 B.B. Road, Ukil Para, Narayanganj 1400', '01710-597395', 'S5', 'B',
    'Small with a "fast service" reputation.',
    { rating: 5.0, reviewCount: 7, suggestedTier: 'Starter' }),
  a('Jatra Bondhu', 'narayanganj', '12th Floor, Rauf Tower, Narayanganj 1400', '01317-290009', 'S5', 'B',
    'Open 24h, corporate tower address, newer operation.',
    { rating: 5.0, reviewCount: 2, open247: true, suggestedTier: 'Starter' }),
  a('EHP Travels', 'narayanganj', 'Shop No. 10, 1st Floor, Narayanganj 1400', '01309-990022', 'S6', 'C',
    'Very small shop-front operation.',
    { rating: 5.0, reviewCount: 1 }),
  a('Sun Air Travel & Tours', 'narayanganj', 'Siddhirganj, Narayanganj 1431', '01618-987743', 'S6', 'C',
    'Industrial-belt location — labour and migrant traffic.',
    { rating: null, reviewCount: null }),

  // ===== CUMILLA ============================================================
  a('Lotus Travels and Holidays', 'cumilla', 'Chowk Bazar Road, Cumilla 3500', '01765-770033', 'S5', 'A',
    'Air ticket plus tour plus Umrah with doorstep service. Qatar-corridor customers. Best Cumilla target.',
    { hajjLicence: 'inferred', rating: 4.5, reviewCount: 10, suggestedTier: 'Growth' }),
  a('Fly Madina Tours & Travels', 'cumilla', 'Cumilla town centre, Cumilla 3500', null, 'S5', 'A',
    'Strong USA / Canada / UK / Saudi / India visa reputation, described locally as the best in Cumilla. No listed phone — visit or Facebook.',
    { rating: 4.8, reviewCount: 5, suggestedTier: 'Growth' }),
  a('Ariyan Tours and Travels', 'cumilla', 'Laksham Road, Cumilla 3500', '01676-457220', 'S5', 'B',
    'Air, hotel and bus ticketing, well reviewed, fully manual.',
    { rating: 4.5, reviewCount: 19, suggestedTier: 'Starter' }),
  a('City Air Travels', 'cumilla', '67/58, Ground Floor, Nahar Plaza, beside Pubali Bank, Nazrul Avenue, Cumilla 3500', '01714-457511', 'S5', 'B',
    'Small bank-adjacent retail counter.',
    { rating: 5.0, reviewCount: 2, suggestedTier: 'Starter' }),
  a('Hoymonte Tour and Travels (Cumilla branch)', 'cumilla', 'Tomsom Bridge, Cumilla 3500', '01710-333296', 'S5', 'B',
    'Branch of a larger operation — multi-branch angle applies.',
    { rating: 5.0, reviewCount: 1, open247: true, suggestedTier: 'Starter' }),
  a('Habib Air Travels & Tours', 'cumilla', 'Near Police Line, Cumilla 3500', '01824-926002', 'S5', 'C',
    'Weak public reviews (3.4). Qualify carefully.',
    { rating: 3.4, reviewCount: 5 }),

  // ===== BRAHMANBARIA =======================================================
  a('Shahjalal Tour & Travels', 'brahmanbaria', 'Masjid Road, Brahmanbaria 3400', '01771-695551', 'S5', 'A',
    'Open 7 days, Qatar-corridor customers, strong local reputation.',
    { rating: 4.8, reviewCount: 21, suggestedTier: 'Growth' }),
  a('Shahin Tours & Travels', 'brahmanbaria', 'Ramkanai School Market, Kumarshil Moor, Brahmanbaria 3400', '01735-601010', 'S5', 'A',
    'A public review reveals they could NOT book a Bangkok\u2013Phuket domestic sector. That is the exact capability gap our GDS closes — one sentence closes this call.',
    { rating: 4.4, reviewCount: 7, suggestedTier: 'Growth' }),
  a("Ananna Tour's & Travels", 'brahmanbaria', '1, 5th Floor, Jhumor Hotel Building, Bhuiyan Mansion, Masjid Road, Brahmanbaria 3400', '01703-000551', 'S5', 'B',
    'Student visa plus tours, self-describes as a corporate office.',
    { rating: 5.0, reviewCount: 7, suggestedTier: 'Starter' }),

  // ===== KHULNA =============================================================
  a('Flygate Global Air Travels', 'khulna', '2nd Floor, Jalal Complex, 50 Daben Babu Road (south of Jinnah Mosque), Khulna 9100', '01711-588144', 'S5', 'A',
    '43 reviews, open 24h, strongest agency in the city. No platform. Best Khulna target.',
    { rating: 5.0, reviewCount: 43, open247: true, suggestedTier: 'Growth' }),
  a('Khulna Air Travels Ltd', 'khulna', 'Khulna city, Khulna 9100', '01735-010160', 'S5', 'A',
    'Described as the most trusted in Khulna — India rail, air and visa services.',
    { rating: 4.7, reviewCount: 20, suggestedTier: 'Growth' }),
  a('GoNest Travel International', 'khulna', 'Hotel Royal International, 33 KDA Avenue, Khulna 9100', '01303-415331', 'S5', 'B',
    'Thailand, Malaysia and India visa specialist. Professional operation.',
    { rating: 5.0, reviewCount: 24, suggestedTier: 'Starter' }),
  a('Cheap Mega Travel Pty Ltd', 'khulna', 'Complex 44, Majid Sarani, Shibbari, Khulna 9100', '01969-777111', 'S5', 'B',
    'Sundarban inbound tours plus air ticketing, open 7 days.',
    { rating: 4.2, reviewCount: 52, suggestedTier: 'Growth' }),
  a('Travel Agent International', 'khulna', '214/6 Sher-E-Bangla Road, Gallamari, NS Towers, 1st Floor, Khulna 9100', '01760-988155', 'S5', 'C',
    'Mid-size with mixed reviews.',
    { rating: 4.3, reviewCount: 6 }),
  a('Green Way Trip & Travel', 'khulna', '18 KDA Avenue, Khulna 9100', '01994-739969', 'S6', 'C',
    'Open 24h, very small.',
    { rating: 5.0, reviewCount: 2, open247: true }),

  // ===== RAJSHAHI ===========================================================
  a('Trip Begin Limited', 'rajshahi', 'Hold 77 (2nd Floor), Court Station Mor, Rajshahi 6201', '01709-377244', 'S5', 'A',
    'Reviews specifically praise that it HOLDS A LICENCE — a reputation-led buyer, and the ideal profile for a credentialed vendor like Softifybd.',
    { caabLicence: 'inferred', rating: 4.9, reviewCount: 44, suggestedTier: 'Growth' }),
  a('Wafiya Travels Aviation', 'rajshahi', 'Thana Mor, Airport Road, Rajshahi 6203', '01707-006113', 'S2', 'A',
    'Hajj, Umrah and international air. Runs an annual pilgrim reunion event — real scale and a community to protect.',
    { hajjLicence: 'inferred', rating: 5.0, reviewCount: 17, suggestedTier: 'Hajj' }),
  a('Sharib Tours & Travels', 'rajshahi', 'Laxmipur More, Shershah Road (in front of Labaid Hospital), Rajshahi 6000', '01720-357814', 'S5', 'A',
    '43 reviews, multi-country family packages (Singapore, Thailand, Vietnam, Maldives).',
    { rating: 4.8, reviewCount: 43, suggestedTier: 'Growth' }),
  a('Make A Wish Rajshahi', 'rajshahi', 'Ghoshpara, Medical College Road, Rajshahi 6000', '01712-703443', 'S5', 'B',
    'Ticketing-focused, professional, small.',
    { rating: 4.6, reviewCount: 10, suggestedTier: 'Starter' }),
  a('Ahammod Tours & Travels', 'rajshahi', 'Hold 77 (2nd Floor), Court Station Road, Rajshahi 6201', '01958-493200', 'S5', 'B',
    'Same building as Trip Begin — two calls, one trip.',
    { rating: 4.3, reviewCount: 3, suggestedTier: 'Starter' }),
  a('Somoy Sokal Travels', 'rajshahi', 'Bornali Mor, Rajshahi 6100', '01718-535174', 'S5', 'B',
    'India visa, Indian rail, domestic and international air, passport processing. Broad manual workload.',
    { rating: 4.6, reviewCount: 5, suggestedTier: 'Starter' }),

  // ===== BOGURA =============================================================
  a('Fly Sky Tour & Travels', 'bogura', 'Merina Road, Bogura', '01750-222444', 'S5', 'A',
    '612 public reviews — by far the largest agency footprint outside the metros, and still no platform. Highest-priority regional target in the country.',
    { rating: 5.0, reviewCount: 612, suggestedTier: 'Professional' }),

  // ===== EXCLUDED — DO NOT PITCH THE STANDARD PACKAGE =======================
  a('goFLY Limited', 'dhanmondi', '1 Shukrabad Road, Motiur Nibash, Dhanmondi, Dhaka 1207', '01713-289171', 'S3', 'X',
    'Publishes every credential and already runs Galileo direct plus its own AI tools. Use as a benchmark and a credential-verification reference, not a prospect.',
    {
      exclusionReason: 'has_own_platform', hasOwnPlatform: true, salesMode: 'own_platform',
      caabLicence: 'verified', caabLicenceNo: '0007726',
      iata: 'verified', iataNo: '42337956',
      atab: 'verified', atabNo: '4298',
      website: 'https://goflybd.com', altPhones: ['09639-203090'],
      rating: 4.8, reviewCount: 482
    }),
  a('Global Travel & Tours', 'paltan', '78/E Purana Paltan Line, 3rd Floor, Bijoynagar, Dhaka 1000', '01810-140650', 'S1', 'X',
    'A public review confirms customers check flight details on their own OTA. Displacement or intelligence call only.',
    { exclusionReason: 'has_own_platform', hasOwnPlatform: true, salesMode: 'own_platform', rating: 4.8, reviewCount: 59, open247: true }),
  a('Tryotel Travels', 'gulshan', '74 Gulshan Avenue, Dhaka 1212', '09606-999966', 'S1', 'X',
    'Reviews reference their own app for tickets, visa and packages. Already platformed.',
    { exclusionReason: 'has_own_platform', hasOwnPlatform: true, salesMode: 'own_platform', rating: 4.6, reviewCount: 71 }),
  a('AKIJ Air', 'gulshan', 'Gulshan 1, Dhaka 1212', '09613-500850', 'S4', 'X',
    'Part of Akij Group. Reviews describe them building their own web portal, reservation system and call centre in-house with corporate backing. Enterprise or partnership conversation only.',
    { exclusionReason: 'building_in_house', hasOwnPlatform: true, salesMode: 'own_platform', rating: 4.9, reviewCount: 74 }),
  a('ShareTrip', 'gulshan', 'House 1, Road 17, Block C, 3rd Floor, Banani, Dhaka 1213', '09617-617617', 'S4', 'X',
    'Market-leading aggregator running its own large B2B portal. Competitor — track their agent terms as intelligence.',
    { exclusionReason: 'is_competitor', hasOwnPlatform: true, salesMode: 'own_platform', ...IATA_INF, rating: 4.4, reviewCount: 1591, website: 'https://b2b.sharetrip.net' }),
  a('AMY / Be Fresh PLC', 'chattogram', '9th Floor, C&F Tower, 1712 Sk Mujib Road, Agrabad, Chattogram 4100', '01730-444545', 'S4', 'X',
    'Fully operating consumer OTA with its own app and very large user base. The dominant digital player in Chattogram.',
    { exclusionReason: 'is_competitor', hasOwnPlatform: true, salesMode: 'own_platform', rating: 4.6, reviewCount: 1107, open247: true, altPhones: ['09678-785656'] }),
  a('Umrah.com.bd', 'hajj-dhaka', '57 Purana Paltan, Trident Tower, New VIP Road, Dhaka 1205', '01720-028498', 'S2', 'X',
    'Already operates as an online Umrah and Hajj agency with a website. Displacement or upgrade only.',
    { exclusionReason: 'has_own_platform', hasOwnPlatform: true, salesMode: 'own_platform', hajjLicence: 'inferred', rating: 3.0, reviewCount: 3 }),
  a('Airways Office / Travel Zoo BD', 'dhanmondi', 'Happy Arcade Shopping Mall, 2nd Floor, Road 3, Dhanmondi, Dhaka 1205', null, 'S4', 'X',
    'COMPETITOR — zooIT / Travel Zoo sells OTA software and IATA-accreditation consultancy, and runs travel-business training in the same suite. Monitor pricing; recruit their graduates.',
    { exclusionReason: 'is_competitor', hasOwnPlatform: true, salesMode: 'own_platform', rating: 4.8, reviewCount: 25 }),
  a('Blue Dream Tours & Travels Ltd', 'dhanmondi', 'Rangs Eminence (11th Floor), Plot 79, Road 27, Dhaka 1205', null, 'S1', 'X',
    'Large hotel-membership-card operation with serious public complaints about the membership sales approach. Compliance review required before any engagement.',
    { exclusionReason: 'compliance_risk', rating: 4.5, reviewCount: 247 }),
  a('Gulf Travels', 'chattogram', 'Agrabad, Chattogram 4100', '01819-319638', 'S2', 'X',
    'Repeated and severe public complaints about Hajj hotel misrepresentation and fee handling. Recommend declining, or escalate to management first.',
    { exclusionReason: 'compliance_risk', hajjLicence: 'inferred', rating: 3.9, reviewCount: 30 })
];

// ---- derived aggregates used across the dashboard ---------------------------

export const TARGETS = AGENCIES.filter((x) => x.priority !== 'X');
export const EXCLUDED = AGENCIES.filter((x) => x.priority === 'X');

const isHeld = (s: CredentialState) => s === 'verified' || s === 'inferred';

export const STATS = {
  total: AGENCIES.length,
  targets: TARGETS.length,
  excluded: EXCLUDED.length,

  /** "Civil Aviation certificate" holders — Ministry / TAMS travel-agency licence. */
  caabHeld: AGENCIES.filter((x) => isHeld(x.caabLicence)).length,
  caabVerified: AGENCIES.filter((x) => x.caabLicence === 'verified').length,
  caabInferred: AGENCIES.filter((x) => x.caabLicence === 'inferred').length,

  iataHeld: AGENCIES.filter((x) => isHeld(x.iata)).length,
  iataVerified: AGENCIES.filter((x) => x.iata === 'verified').length,
  iataInferred: AGENCIES.filter((x) => x.iata === 'inferred').length,
  iataUnknown: AGENCIES.filter((x) => x.iata === 'unknown').length,

  hajjHeld: AGENCIES.filter((x) => isHeld(x.hajjLicence)).length,

  noPlatform: TARGETS.filter((x) => !x.hasOwnPlatform).length,
  open247: TARGETS.filter((x) => x.open247).length,
  noPhone: TARGETS.filter((x) => !x.phone).length,

  priorityA: TARGETS.filter((x) => x.priority === 'A').length,
  priorityB: TARGETS.filter((x) => x.priority === 'B').length,
  priorityC: TARGETS.filter((x) => x.priority === 'C').length,

  districts: Array.from(new Set(AGENCIES.map((x) => x.district))).length,
  clusters: Array.from(new Set(AGENCIES.map((x) => x.clusterId))).length,

  /** Public review count as a scale proxy — total reach represented. */
  totalReviews: AGENCIES.reduce((s, x) => s + (x.reviewCount ?? 0), 0)
};

export function countBy<T extends string>(rows: Agency[], key: (a: Agency) => T) {
  const m = new Map<T, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return m;
}

/** Indicative pipeline value from the pricing framework. Mid-point of each tier. */
const TIER_MRR: Record<string, number> = {
  Starter: 10000, Growth: 23000, Professional: 47500, Hajj: 35000, Enterprise: 60000
};
export const PIPELINE = {
  /** Total addressable MRR if every A/B target signed at its suggested tier. */
  fullMrr: TARGETS.reduce((s, x) => s + (x.suggestedTier ? TIER_MRR[x.suggestedTier] : 0), 0),
  aMrr: TARGETS.filter((x) => x.priority === 'A').reduce(
    (s, x) => s + (x.suggestedTier ? TIER_MRR[x.suggestedTier] : 0), 0
  )
};

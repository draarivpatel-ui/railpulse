/* RailPulse preloaded corridor bundle.
 *
 * Station names, station order, operators, route shapes and cumulative route
 * miles are drawn from published timetables, line maps and milepost charts.
 * Approximate WGS84 anchor coordinates trace each real corridor so the SVG map
 * shows the actual geographic shape of the line. Station coordinates are
 * interpolated along those anchors by cumulative route distance, so they are
 * approximate, not survey grade.
 *
 * Headways, dwell times and service spans below are illustrative regular
 * interval timetables, not extracted live schedules. They exist so the headway,
 * bunching, dwell and delay models can run offline with zero dependencies and
 * zero network calls. Upload a real GTFS static bundle or a GTFS-RT feed in the
 * app to replace them with observed data.
 */
(function (root) {
  "use strict";
  var ns = root.RailPulse || (root.RailPulse = {});

  var PROVENANCE = [
    "Amtrak Northeast Corridor: published NEC mileposts, Boston to Washington.",
    "Houston METRORail: published Red, Green and Purple line station lists.",
    "Caltrain: published peninsula mileposts, San Francisco to Gilroy.",
    "CTA L: published Blue Line (O'Hare to Forest Park) and Red Line (Howard to 95th/Dan Ryan) station lists.",
    "All timetables are synthetic regular interval services for offline analysis."
  ];

  /* Station tuple: [code, name, cumulative miles from origin, planned dwell seconds] */
  /* Anchor tuple: [latitude, longitude] tracing the real corridor geometry. */

  var CORRIDORS = [
    {
      id: "nec",
      name: "Amtrak Northeast Corridor",
      shortName: "NEC Regional",
      operator: "Amtrak",
      kind: "intercity",
      colorKey: 1,
      routeId: "NEC",
      directionLabel: "Boston to Washington",
      speedMph: 68,
      headwaySec: 1800,
      startSec: 6 * 3600,
      endSec: 22 * 3600,
      anchors: [
        [42.3519, -71.0552], [42.3460, -71.0750], [42.2180, -71.2920],
        [41.8240, -71.4128], [41.5900, -71.4600], [41.3770, -71.7600],
        [41.3550, -72.0900], [41.3083, -72.9279], [41.1600, -73.2300],
        [40.9000, -73.7800], [40.7506, -74.1650], [40.7359, -73.9903],
        [40.2200, -74.7600], [39.9556, -75.1819], [39.7300, -75.5500],
        [39.3050, -76.6150], [39.1800, -76.8700], [38.9070, -77.0360]
      ],
      stations: [
        ["BOS", "Boston South Station", 0.0, 180],
        ["BBY", "Boston Back Bay", 1.2, 60],
        ["RTE", "Route 128", 11.4, 45],
        ["PVD", "Providence", 43.7, 90],
        ["KIN", "Kingston", 63.4, 45],
        ["WLY", "Westerly", 84.0, 45],
        ["NLC", "New London", 105.5, 75],
        ["OSB", "Old Saybrook", 127.0, 45],
        ["NHV", "New Haven Union", 157.0, 120],
        ["BRP", "Bridgeport", 178.0, 60],
        ["STM", "Stamford", 196.6, 75],
        ["NYP", "New York Penn", 231.0, 180],
        ["NWK", "Newark Penn", 241.0, 90],
        ["MET", "Metropark", 254.0, 60],
        ["TRE", "Trenton", 289.0, 75],
        ["PHL", "Philadelphia 30th Street", 320.0, 150],
        ["WIL", "Wilmington", 346.0, 75],
        ["BAL", "Baltimore Penn", 414.0, 120],
        ["BWI", "BWI Airport", 424.0, 60],
        ["NCR", "New Carrollton", 448.0, 60],
        ["WAS", "Washington Union", 457.0, 180]
      ]
    },
    {
      id: "metrorail-red",
      name: "Houston METRORail Red Line",
      shortName: "METRORail Red",
      operator: "METRO",
      kind: "light rail",
      colorKey: 8,
      routeId: "RED",
      directionLabel: "Fannin South to Northline",
      speedMph: 22,
      headwaySec: 720,
      startSec: 5 * 3600,
      endSec: 24 * 3600,
      anchors: [
        [29.6710, -95.3970], [29.6840, -95.3980], [29.7060, -95.4020],
        [29.7180, -95.3950], [29.7350, -95.3820], [29.7520, -95.3700],
        [29.7620, -95.3620], [29.7750, -95.3550], [29.7950, -95.3520],
        [29.8180, -95.3500], [29.8420, -95.3480]
      ],
      stations: [
        ["FNS", "Fannin South", 0.0, 60],
        ["STA", "Stadium Park / Astrodome", 0.6, 25],
        ["SML", "Smith Lands", 1.3, 25],
        ["TMC", "Texas Medical Center", 2.2, 35],
        ["DRY", "Dryden / TMC", 2.7, 25],
        ["RIC", "Hermann Park / Rice U", 3.3, 25],
        ["MUS", "Museum District", 3.9, 25],
        ["WHE", "Wheeler", 4.6, 25],
        ["ENS", "Ensemble / HCC", 5.4, 25],
        ["DTC", "Downtown Transit Center", 6.3, 40],
        ["BEL", "Bell", 7.0, 25],
        ["MSQ", "Main Street Square", 7.5, 30],
        ["CEN", "Central Station", 8.0, 35],
        ["PRE", "Preston", 8.5, 25],
        ["UHD", "UH Downtown", 9.2, 30],
        ["BUR", "Burnett Transit Center", 9.9, 30],
        ["CAS", "Cass / Intermodal", 10.4, 25],
        ["MOO", "Moody Park", 11.0, 25],
        ["CAV", "Cavalcade", 11.8, 25],
        ["LIN", "Lindale Park", 12.5, 25],
        ["MEL", "Melbourne / North Lindale", 13.2, 25],
        ["NTC", "Northline Transit Center", 13.9, 60]
      ]
    },
    {
      id: "metrorail-green",
      name: "Houston METRORail Green Line",
      shortName: "METRORail Green",
      operator: "METRO",
      kind: "light rail",
      colorKey: 3,
      routeId: "GREEN",
      directionLabel: "Magnolia Park to Theater District",
      speedMph: 21,
      headwaySec: 900,
      startSec: 5 * 3600,
      endSec: 24 * 3600,
      anchors: [
        [29.7420, -95.2570], [29.7400, -95.2820], [29.7410, -95.3050],
        [29.7440, -95.3250], [29.7470, -95.3450], [29.7520, -95.3600],
        [29.7580, -95.3680], [29.7620, -95.3750]
      ],
      stations: [
        ["MPT", "Magnolia Park Transit Center", 0.0, 60],
        ["ALT", "Altic / Howard Hughes", 0.8, 25],
        ["CCV", "Cesar Chavez / 67th", 1.6, 25],
        ["H65", "Harrisburg / 65th", 2.3, 25],
        ["HWY", "Harrisburg / Wayside", 3.0, 25],
        ["LEE", "Leeland / Third Ward", 3.8, 25],
        ["ELG", "Elgin / Third Ward", 4.4, 30],
        ["TSU", "TSU / UH Athletics District", 5.0, 25],
        ["EAD", "EaDo / Stadium", 5.7, 30],
        ["CON", "Convention District", 6.4, 25],
        ["CEN", "Central Station", 7.0, 35],
        ["MSQ", "Main Street Square", 7.5, 25],
        ["BEL", "Bell", 8.0, 25],
        ["DTC", "Downtown Transit Center", 8.5, 30],
        ["THD", "Theater District", 9.1, 60]
      ]
    },
    {
      id: "metrorail-purple",
      name: "Houston METRORail Purple Line",
      shortName: "METRORail Purple",
      operator: "METRO",
      kind: "light rail",
      colorKey: 7,
      routeId: "PURPLE",
      directionLabel: "Palm Center to Theater District",
      speedMph: 21,
      headwaySec: 900,
      startSec: 5 * 3600,
      endSec: 24 * 3600,
      anchors: [
        [29.6610, -95.3230], [29.6820, -95.3350], [29.7000, -95.3440],
        [29.7180, -95.3450], [29.7350, -95.3550], [29.7480, -95.3620],
        [29.7580, -95.3700], [29.7620, -95.3750]
      ],
      stations: [
        ["PCT", "Palm Center Transit Center", 0.0, 60],
        ["MAC", "MacGregor Way / MLK", 0.7, 25],
        ["MLK", "Martin Luther King Jr", 1.4, 25],
        ["TIE", "Tierwester / Scott", 2.1, 25],
        ["SCT", "Scott / Holcombe", 2.8, 25],
        ["ELG", "Elgin / Third Ward", 3.6, 30],
        ["TSU", "TSU / UH Athletics District", 4.2, 25],
        ["EAD", "EaDo / Stadium", 4.9, 30],
        ["CON", "Convention District", 5.6, 25],
        ["CEN", "Central Station", 6.2, 35],
        ["MSQ", "Main Street Square", 6.7, 25],
        ["BEL", "Bell", 7.2, 25],
        ["DTC", "Downtown Transit Center", 7.7, 30],
        ["THD", "Theater District", 8.3, 60]
      ]
    },
    {
      id: "caltrain",
      name: "Caltrain Peninsula Corridor",
      shortName: "Caltrain",
      operator: "Caltrain",
      kind: "commuter rail",
      colorKey: 8,
      routeId: "CALTRAIN",
      directionLabel: "San Francisco to Gilroy",
      speedMph: 44,
      headwaySec: 1800,
      startSec: 5 * 3600,
      endSec: 23 * 3600,
      anchors: [
        [37.7765, -122.3950], [37.7570, -122.3920], [37.7080, -122.4010],
        [37.6550, -122.4060], [37.6300, -122.4120], [37.5990, -122.3870],
        [37.5700, -122.3450], [37.5200, -122.3100], [37.4870, -122.2350],
        [37.4540, -122.1820], [37.4300, -122.1500], [37.3900, -122.0800],
        [37.3540, -122.0400], [37.3300, -121.9500], [37.3200, -121.9000],
        [37.3000, -121.8500], [37.2600, -121.8000], [37.2000, -121.7500]
      ],
      stations: [
        ["SFK", "San Francisco 4th and King", 0.0, 180],
        ["22N", "22nd Street", 1.9, 30],
        ["BYS", "Bayshore", 4.2, 30],
        ["SSF", "South San Francisco", 8.0, 35],
        ["SBR", "San Bruno", 10.7, 30],
        ["MBR", "Millbrae", 13.7, 60],
        ["BWY", "Broadway", 15.2, 30],
        ["BGM", "Burlingame", 16.9, 30],
        ["SMT", "San Mateo", 18.9, 40],
        ["HWP", "Hayward Park", 20.3, 30],
        ["HIL", "Hillsdale", 22.3, 40],
        ["BEL", "Belmont", 24.3, 30],
        ["SCA", "San Carlos", 25.8, 30],
        ["RWC", "Redwood City", 27.8, 50],
        ["MPK", "Menlo Park", 30.1, 35],
        ["PAL", "Palo Alto", 32.5, 60],
        ["CAL", "California Avenue", 35.0, 30],
        ["SAN", "San Antonio", 37.0, 30],
        ["MVW", "Mountain View", 39.6, 45],
        ["SUN", "Sunnyvale", 42.0, 40],
        ["LAW", "Lawrence", 44.0, 30],
        ["SCL", "Santa Clara", 45.8, 35],
        ["CPK", "College Park", 46.7, 30],
        ["SJD", "San Jose Diridon", 47.5, 120],
        ["TAM", "Tamien", 49.9, 40],
        ["CAP", "Capitol", 53.0, 30],
        ["BLH", "Blossom Hill", 57.0, 30],
        ["MGH", "Morgan Hill", 65.0, 35],
        ["SMN", "San Martin", 70.0, 30],
        ["GLY", "Gilroy", 77.4, 180]
      ]
    },
    {
      id: "cta-blue",
      name: "CTA L Blue Line",
      shortName: "CTA Blue",
      operator: "CTA",
      kind: "metro",
      colorKey: 1,
      routeId: "BLUE",
      directionLabel: "O'Hare to Forest Park",
      speedMph: 26,
      headwaySec: 600,
      startSec: 5 * 3600,
      endSec: 24 * 3600,
      anchors: [
        [41.9780, -87.9020], [41.9830, -87.8600], [41.9680, -87.8100],
        [41.9530, -87.7650], [41.9380, -87.7300], [41.9220, -87.7070],
        [41.9080, -87.6900], [41.8850, -87.6350], [41.8800, -87.6000],
        [41.8780, -87.6300]
      ],
      stations: [
        ["OHR", "O'Hare", 0.0, 120],
        ["ROS", "Rosemont", 1.6, 30],
        ["CUM", "Cumberland", 3.1, 30],
        ["HAR", "Harlem (O'Hare)", 4.5, 35],
        ["JFP", "Jefferson Park", 6.2, 40],
        ["MON", "Montrose", 7.6, 30],
        ["IRV", "Irving Park", 8.6, 30],
        ["ADD", "Addison", 9.4, 30],
        ["BLM", "Belmont", 10.3, 35],
        ["LOG", "Logan Square", 11.7, 40],
        ["CAL", "California", 12.6, 30],
        ["WRN", "Western", 13.4, 30],
        ["DAM", "Damen", 14.2, 30],
        ["DIV", "Division", 15.0, 30],
        ["CHI", "Chicago", 15.8, 35],
        ["GRA", "Grand", 16.6, 30],
        ["CLK", "Clark / Lake", 17.5, 50],
        ["WSH", "Washington", 18.0, 30],
        ["MNR", "Monroe", 18.4, 30],
        ["JCK", "Jackson", 18.8, 35],
        ["LAS", "LaSalle", 19.2, 30],
        ["CLN", "Clinton", 19.7, 35],
        ["UIC", "UIC Halsted", 20.4, 30],
        ["RAC", "Racine", 21.1, 30],
        ["PLK", "Polk", 21.7, 30],
        ["18T", "18th", 22.3, 30],
        ["KED", "Kedzie Homan", 23.6, 30],
        ["PUL", "Pulaski", 24.5, 30],
        ["CIC", "Cicero", 25.4, 30],
        ["AUS", "Austin", 26.3, 30],
        ["OKP", "Oak Park", 27.2, 30],
        ["HRL", "Harlem (Forest Park)", 28.1, 30],
        ["FRP", "Forest Park", 28.9, 120]
      ]
    },
    {
      id: "cta-red",
      name: "CTA L Red Line",
      shortName: "CTA Red",
      operator: "CTA",
      kind: "metro",
      colorKey: 8,
      routeId: "RED-CTA",
      directionLabel: "Howard to 95th / Dan Ryan",
      speedMph: 25,
      headwaySec: 480,
      startSec: 5 * 3600,
      endSec: 24 * 3600,
      anchors: [
        [42.0190, -87.6730], [41.9900, -87.6680], [41.9600, -87.6600],
        [41.9400, -87.6530], [41.9100, -87.6460], [41.8800, -87.6300],
        [41.8500, -87.6270], [41.8100, -87.6280], [41.7600, -87.6300],
        [41.7100, -87.6270], [41.6500, -87.6250]
      ],
      stations: [
        ["HOW", "Howard", 0.0, 120],
        ["JRV", "Jarvis", 0.5, 25],
        ["MOR", "Morse", 1.0, 25],
        ["LOY", "Loyola", 1.5, 30],
        ["GRN", "Granville", 2.0, 25],
        ["THD", "Thorndale", 2.6, 25],
        ["BRM", "Bryn Mawr", 3.2, 30],
        ["BER", "Berwyn", 3.8, 25],
        ["ARG", "Argyle", 4.4, 25],
        ["LAW", "Lawrence", 5.0, 30],
        ["WIL", "Wilson", 5.6, 35],
        ["SHE", "Sheridan", 6.2, 25],
        ["ADD", "Addison", 6.9, 30],
        ["BLM", "Belmont", 7.6, 35],
        ["FUL", "Fullerton", 8.4, 40],
        ["NCL", "North / Clybourn", 9.2, 30],
        ["CDV", "Clark / Division", 10.1, 30],
        ["CHI", "Chicago", 10.9, 35],
        ["GRA", "Grand", 11.6, 30],
        ["LAK", "Lake", 12.2, 40],
        ["MNR", "Monroe", 12.7, 30],
        ["JCK", "Jackson", 13.2, 35],
        ["HAR", "Harrison", 13.7, 30],
        ["PLK", "Polk", 14.2, 25],
        ["CCN", "Cermak Chinatown", 15.0, 30],
        ["35T", "Sox 35th", 15.9, 35],
        ["47T", "47th", 16.9, 30],
        ["GAR", "Garfield", 18.0, 35],
        ["63R", "63rd", 19.2, 30],
        ["69T", "69th", 20.1, 30],
        ["79T", "79th", 21.2, 30],
        ["87T", "87th", 22.3, 30],
        ["95T", "95th / Dan Ryan", 23.4, 120]
      ]
    }
  ];

  ns.CORRIDORS = CORRIDORS;
  ns.CORRIDOR_PROVENANCE = PROVENANCE;
  if (typeof module === "object" && module.exports) module.exports = CORRIDORS;
})(typeof globalThis !== "undefined" ? globalThis : this);

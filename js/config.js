// ============================================================
// THE DNA LEAGUE — config.js
// Single source of truth for all app configuration.
// Update Supabase credentials here only.
// ============================================================

const DNA_CONFIG = {
  supabase: {
    url:  'https://orhpiuwptucgktioigju.supabase.co',
    anon: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yaHBpdXdwdHVjZ2t0aW9pZ2p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NTIwNjIsImV4cCI6MjA5MDAyODA2Mn0.crGOk7q2k6lr4RDgGCBmgKF8hh1BykSTcRiAefmf7pQ',
  },

  app: {
    name:    'The DNA League',
    version: '1.0.0',
    game:    'MLB The Show',
  },

  draft: {
    defaultTimerSeconds: 90,
    minTimerSeconds:     30,
    maxTimerSeconds:     300,
    maxTeams:            32,
  },

  // Ratings source — abstracted so other sports can be added later
  // type: 'mlbtheshow' | 'static' | 'custom'
  ratings: {
    sport:      'baseball',
    game:       'mlbtheshow',
    gameYear:   2026,
    apiBase:    'https://mlb26.theshow.com/apis',
    // Community mirror used as fallback (CORS-friendly)
    mirrorBase: 'https://mlb-the-show-api.p.rapidapi.com',
  },

  // MLB teams — static reference used across the app
  mlbTeams: [
    { name:'Arizona Diamondbacks',  abbr:'ARI', city:'Arizona',       league:'NL', division:'West'    },
    { name:'Atlanta Braves',         abbr:'ATL', city:'Atlanta',       league:'NL', division:'East'    },
    { name:'Baltimore Orioles',      abbr:'BAL', city:'Baltimore',     league:'AL', division:'East'    },
    { name:'Boston Red Sox',         abbr:'BOS', city:'Boston',        league:'AL', division:'East'    },
    { name:'Chicago Cubs',           abbr:'CHC', city:'Chicago',       league:'NL', division:'Central' },
    { name:'Chicago White Sox',      abbr:'CWS', city:'Chicago',       league:'AL', division:'Central' },
    { name:'Cincinnati Reds',        abbr:'CIN', city:'Cincinnati',    league:'NL', division:'Central' },
    { name:'Cleveland Guardians',    abbr:'CLE', city:'Cleveland',     league:'AL', division:'Central' },
    { name:'Colorado Rockies',       abbr:'COL', city:'Colorado',      league:'NL', division:'West'    },
    { name:'Detroit Tigers',         abbr:'DET', city:'Detroit',       league:'AL', division:'Central' },
    { name:'Houston Astros',         abbr:'HOU', city:'Houston',       league:'AL', division:'West'    },
    { name:'Kansas City Royals',     abbr:'KC',  city:'Kansas City',   league:'AL', division:'Central' },
    { name:'Los Angeles Angels',     abbr:'LAA', city:'Los Angeles',   league:'AL', division:'West'    },
    { name:'Los Angeles Dodgers',    abbr:'LAD', city:'Los Angeles',   league:'NL', division:'West'    },
    { name:'Miami Marlins',          abbr:'MIA', city:'Miami',         league:'NL', division:'East'    },
    { name:'Milwaukee Brewers',      abbr:'MIL', city:'Milwaukee',     league:'NL', division:'Central' },
    { name:'Minnesota Twins',        abbr:'MIN', city:'Minnesota',     league:'AL', division:'Central' },
    { name:'New York Mets',          abbr:'NYM', city:'New York',      league:'NL', division:'East'    },
    { name:'New York Yankees',       abbr:'NYY', city:'New York',      league:'AL', division:'East'    },
    { name:'Oakland Athletics',      abbr:'OAK', city:'Oakland',       league:'AL', division:'West'    },
    { name:'Philadelphia Phillies',  abbr:'PHI', city:'Philadelphia',  league:'NL', division:'East'    },
    { name:'Pittsburgh Pirates',     abbr:'PIT', city:'Pittsburgh',    league:'NL', division:'Central' },
    { name:'San Diego Padres',       abbr:'SD',  city:'San Diego',     league:'NL', division:'West'    },
    { name:'San Francisco Giants',   abbr:'SF',  city:'San Francisco', league:'NL', division:'West'    },
    { name:'Seattle Mariners',       abbr:'SEA', city:'Seattle',       league:'AL', division:'West'    },
    { name:'St. Louis Cardinals',    abbr:'STL', city:'St. Louis',     league:'NL', division:'Central' },
    { name:'Tampa Bay Rays',         abbr:'TB',  city:'Tampa Bay',     league:'AL', division:'East'    },
    { name:'Texas Rangers',          abbr:'TEX', city:'Texas',         league:'AL', division:'West'    },
    { name:'Toronto Blue Jays',      abbr:'TOR', city:'Toronto',       league:'AL', division:'East'    },
    { name:'Washington Nationals',   abbr:'WSH', city:'Washington',    league:'NL', division:'East'    },
  ],
};
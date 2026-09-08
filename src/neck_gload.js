/**
 * neck_gload.js -- reference marks for the neck test: what a cervical-spine
 * model says the neck has to produce to hold the head against 1-6 g of
 * lateral (cornering) load. Source: N. Berger, BSc thesis 2025W (Uni Vienna),
 * simulations_v3 batch -- Vasavada-type HYOID 1.2 model, 72 muscles, 6 kg
 * head, triangular 2 s ramp, static optimisation, ID with the load applied.
 *
 * Numbers are peak values at the top of the ramp. `rollNm` is the ground
 * roll moment the neck resists; `muscles` are peak forces in N. `saturated`
 * counts muscles at activation ~1: from 4 g the model is out of capacity
 * and the force-g relation stops being physiological -- say so on the chart.
 *
 * Generated from qc_summary.csv + results_tidy.csv; regenerate rather than
 * hand-edit.
 */
export const NECK_GLOAD_SOURCE = "Berger N., BSc thesis 2025W, HYOID 1.2 cervical model, static optimisation";
export const NECK_MUSCLE_LABEL = {
  "trap_acr": "Trapezius (acromial)",
  "stern_mast_L": "Sternocleidomastoid (L)",
  "scalenus_ant_L": "Scalenus anterior (L)",
  "levator_scap_L": "Levator scapulae (L)",
  "splen_cerv_c3thx_L": "Splenius cervicis (L)"
};
export const NECK_MUSCLE_FMAX = {
  "trap_acr": 527.7,
  "stern_mast_L": 186.2,
  "scalenus_ant_L": 138.9,
  "levator_scap_L": 106.8,
  "splen_cerv_c3thx_L": 69.3
};
export const NECK_GLOAD = {
  "lateral": [
    {
      "g": 1,
      "forceN": 58.8,
      "rollNm": 32.23,
      "saturated": 0,
      "muscles": {
        "trap_acr": 70.9,
        "stern_mast_L": 26.2,
        "scalenus_ant_L": 42.0,
        "levator_scap_L": 56.0,
        "splen_cerv_c3thx_L": 13.9
      }
    },
    {
      "g": 2,
      "forceN": 117.7,
      "rollNm": 64.47,
      "saturated": 1,
      "muscles": {
        "trap_acr": 143.3,
        "stern_mast_L": 59.3,
        "scalenus_ant_L": 85.9,
        "levator_scap_L": 103.2,
        "splen_cerv_c3thx_L": 26.4
      }
    },
    {
      "g": 3,
      "forceN": 176.5,
      "rollNm": 96.7,
      "saturated": 7,
      "muscles": {
        "trap_acr": 444.7,
        "stern_mast_L": 85.6,
        "scalenus_ant_L": 122.8,
        "levator_scap_L": 103.2,
        "splen_cerv_c3thx_L": 69.3
      }
    },
    {
      "g": 4,
      "forceN": 235.4,
      "rollNm": 128.94,
      "saturated": 28,
      "muscles": {
        "trap_acr": 525.7,
        "stern_mast_L": 165.0,
        "scalenus_ant_L": 122.8,
        "levator_scap_L": 103.2,
        "splen_cerv_c3thx_L": 69.3
      }
    },
    {
      "g": 5,
      "forceN": 294.2,
      "rollNm": 161.17,
      "saturated": 31,
      "muscles": {
        "trap_acr": 525.7,
        "stern_mast_L": 165.0,
        "scalenus_ant_L": 122.8,
        "levator_scap_L": 103.2,
        "splen_cerv_c3thx_L": 69.3
      }
    },
    {
      "g": 6,
      "forceN": 353.0,
      "rollNm": 193.41,
      "saturated": 33,
      "muscles": {
        "trap_acr": 525.7,
        "stern_mast_L": 165.0,
        "scalenus_ant_L": 122.8,
        "levator_scap_L": 103.2,
        "splen_cerv_c3thx_L": 69.3
      }
    }
  ],
  "combined": [
    {
      "g": 1,
      "forceN": 0.0,
      "rollNm": 0.0,
      "saturated": 0,
      "muscles": {
        "trap_acr": 6.5,
        "stern_mast_L": 1.7,
        "scalenus_ant_L": 1.3,
        "levator_scap_L": 4.7,
        "splen_cerv_c3thx_L": 1.5
      }
    },
    {
      "g": 2,
      "forceN": 101.9,
      "rollNm": 55.83,
      "saturated": 0,
      "muscles": {
        "trap_acr": 122.9,
        "stern_mast_L": 51.2,
        "scalenus_ant_L": 73.8,
        "levator_scap_L": 92.1,
        "splen_cerv_c3thx_L": 22.7
      }
    },
    {
      "g": 3,
      "forceN": 166.4,
      "rollNm": 91.17,
      "saturated": 6,
      "muscles": {
        "trap_acr": 368.9,
        "stern_mast_L": 79.0,
        "scalenus_ant_L": 122.8,
        "levator_scap_L": 103.2,
        "splen_cerv_c3thx_L": 61.8
      }
    },
    {
      "g": 4,
      "forceN": 227.9,
      "rollNm": 124.85,
      "saturated": 25,
      "muscles": {
        "trap_acr": 525.7,
        "stern_mast_L": 165.0,
        "scalenus_ant_L": 122.8,
        "levator_scap_L": 103.2,
        "splen_cerv_c3thx_L": 69.3
      }
    },
    {
      "g": 5,
      "forceN": 288.3,
      "rollNm": 157.92,
      "saturated": 31,
      "muscles": {
        "trap_acr": 525.7,
        "stern_mast_L": 165.0,
        "scalenus_ant_L": 122.8,
        "levator_scap_L": 103.2,
        "splen_cerv_c3thx_L": 69.3
      }
    },
    {
      "g": 6,
      "forceN": 348.1,
      "rollNm": 190.7,
      "saturated": 33,
      "muscles": {
        "trap_acr": 525.7,
        "stern_mast_L": 165.0,
        "scalenus_ant_L": 122.8,
        "levator_scap_L": 103.2,
        "splen_cerv_c3thx_L": 69.3
      }
    }
  ]
};

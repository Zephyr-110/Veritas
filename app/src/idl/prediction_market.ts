/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `app/src/idl/prediction_market.json`.
 */
export type PredictionMarket = {
  "address": "CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER",
  "metadata": {
    "name": "predictionMarket",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "addLiquidity",
      "discriminator": [
        181,
        157,
        89,
        67,
        143,
        182,
        52,
        72
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.id",
                "account": "Market"
              }
            ]
          }
        },
        {
          "name": "lpPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "account",
                "path": "signer"
              }
            ]
          }
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "businessmanYesAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "yesMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "businessmanNoAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "noMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "collateralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "businessmanCollateralAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "collateralMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "yesPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "associatedTokenProgram"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "collateralAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "burnAccount",
      "discriminator": [
        150,
        61,
        51,
        97,
        24,
        5,
        29,
        238
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.id",
                "account": "Market"
              }
            ]
          }
        },
        {
          "name": "snapshot",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  110,
                  97,
                  112,
                  115,
                  104,
                  111,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "collateralAta",
          "writable": true
        },
        {
          "name": "collateralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "createMarket",
      "discriminator": [
        103,
        226,
        97,
        235,
        200,
        188,
        251,
        254
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "param.marketId"
              }
            ]
          }
        },
        {
          "name": "ocr2State"
        },
        {
          "name": "snapshot",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  110,
                  97,
                  112,
                  115,
                  104,
                  111,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "lpPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "account",
                "path": "creator"
              }
            ]
          }
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "collateralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "creatorCollateralAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "collateralMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "yesPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        },
        {
          "name": "associatedTokenProgram"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "param",
          "type": {
            "defined": {
              "name": "CreateMarketParams"
            }
          }
        }
      ]
    },
    {
      "name": "getCollateral",
      "discriminator": [
        44,
        121,
        236,
        104,
        224,
        169,
        223,
        129
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.id",
                "account": "Market"
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "writable": true
        },
        {
          "name": "tokenAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "tokenMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "collateralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "userCollateralAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "collateralMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "getLiquidity",
      "discriminator": [
        124,
        96,
        247,
        111,
        190,
        1,
        189,
        24
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.id",
                "account": "Market"
              }
            ]
          }
        },
        {
          "name": "lpPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  112,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "account",
                "path": "signer"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "makerYesAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "yesMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "makerNoAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "noMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "yesPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        },
        {
          "name": "associatedTokenProgram"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lpShare",
          "type": "u64"
        }
      ]
    },
    {
      "name": "mergeToken",
      "discriminator": [
        124,
        100,
        36,
        120,
        132,
        9,
        212,
        69
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.id",
                "account": "Market"
              }
            ]
          }
        },
        {
          "name": "collateralAta",
          "writable": true
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "collateralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesTokenAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "yesMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "noTokenAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "noMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "mergeAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "resolveMarket",
      "discriminator": [
        155,
        23,
        80,
        173,
        46,
        74,
        23,
        239
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.id",
                "account": "Market"
              }
            ]
          }
        },
        {
          "name": "snapshot",
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  110,
                  97,
                  112,
                  115,
                  104,
                  111,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "ocr2State"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "param",
          "type": {
            "defined": {
              "name": "ResolveMarketParam"
            }
          }
        }
      ]
    },
    {
      "name": "swap",
      "discriminator": [
        248,
        198,
        158,
        145,
        225,
        117,
        135,
        200
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.id",
                "account": "Market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesTokenAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "yesMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "noTokenAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "noMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "yesPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "param",
          "type": {
            "defined": {
              "name": "SwapParams"
            }
          }
        }
      ]
    },
    {
      "name": "takeSnapshot",
      "discriminator": [
        183,
        210,
        251,
        68,
        140,
        132,
        191,
        140
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "market"
        },
        {
          "name": "snapshot",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  110,
                  97,
                  112,
                  115,
                  104,
                  111,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "ocr2State"
        },
        {
          "name": "feed"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "userBetOn",
      "discriminator": [
        46,
        99,
        16,
        96,
        114,
        4,
        54,
        181
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.id",
                "account": "Market"
              }
            ]
          }
        },
        {
          "name": "collateralAta",
          "writable": true
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "collateralVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesTokenAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "yesMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "noTokenAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "noMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "yesPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noPool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  112,
                  111,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        },
        {
          "name": "associatedTokenProgram"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "param",
          "type": {
            "defined": {
              "name": "UserBetOnParams"
            }
          }
        }
      ]
    },
    {
      "name": "voidMarket",
      "discriminator": [
        243,
        175,
        46,
        124,
        95,
        101,
        39,
        69
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.id",
                "account": "Market"
              }
            ]
          }
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "LpPosition",
      "discriminator": [
        105,
        241,
        37,
        200,
        224,
        2,
        252,
        90
      ]
    },
    {
      "name": "Market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    },
    {
      "name": "MarketSnapshot",
      "discriminator": [
        107,
        32,
        221,
        188,
        130,
        114,
        104,
        28
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "MarketNotOpen",
      "msg": "Market is not open."
    },
    {
      "code": 6001,
      "name": "MarketNotResolved",
      "msg": "Market is not resolved or voided."
    },
    {
      "code": 6002,
      "name": "MarketNotTradable",
      "msg": "Market must be open, resolved, or voided."
    },
    {
      "code": 6003,
      "name": "MarketExpired",
      "msg": "Market has expired."
    },
    {
      "code": 6004,
      "name": "MarketNotExpired",
      "msg": "Market has not expired yet."
    },
    {
      "code": 6005,
      "name": "InvalidAmount",
      "msg": "Amount or expiry is invalid."
    },
    {
      "code": 6006,
      "name": "InsufficientBalance",
      "msg": "Insufficient token balance."
    },
    {
      "code": 6007,
      "name": "EmptyPool",
      "msg": "Pool reserves are empty."
    },
    {
      "code": 6008,
      "name": "SlippageExceeded",
      "msg": "Output is below the slippage limit."
    },
    {
      "code": 6009,
      "name": "ZeroLp",
      "msg": "LP amount must be greater than zero."
    },
    {
      "code": 6010,
      "name": "InvalidMint",
      "msg": "Mint does not belong to this market."
    },
    {
      "code": 6011,
      "name": "NotWinnerMint",
      "msg": "Only the winning token can be redeemed."
    },
    {
      "code": 6012,
      "name": "InvalidPrice",
      "msg": "Price is out of range."
    },
    {
      "code": 6013,
      "name": "InvalidLiquidity",
      "msg": "Liquidity is invalid."
    },
    {
      "code": 6014,
      "name": "MathOverflow",
      "msg": "Fixed-point math overflow."
    },
    {
      "code": 6015,
      "name": "InvalidDuration",
      "msg": "Duration is invalid."
    },
    {
      "code": 6016,
      "name": "InvalidBudget",
      "msg": "Budget is invalid."
    },
    {
      "code": 6017,
      "name": "NotFirstAfterExpiry",
      "msg": "Reports are not two adjacent oracle rounds straddling expiry."
    },
    {
      "code": 6018,
      "name": "MarketNotInWindow",
      "msg": "Market is not in the required time window."
    },
    {
      "code": 6019,
      "name": "NoCreator",
      "msg": "Signer is not the market creator."
    },
    {
      "code": 6020,
      "name": "NoArriveFinishTS",
      "msg": "Claim window has not ended yet."
    },
    {
      "code": 6021,
      "name": "MarketIsOpen",
      "msg": "Market is still open."
    },
    {
      "code": 6022,
      "name": "InvalidOracleInput",
      "msg": "Oracle report or state data is malformed."
    },
    {
      "code": 6023,
      "name": "OracleDigestMismatch",
      "msg": "Oracle report was not signed under the feed's current config."
    },
    {
      "code": 6024,
      "name": "WrongNumberOfSignatures",
      "msg": "Oracle report has the wrong number of signatures."
    },
    {
      "code": 6025,
      "name": "InvalidOracleSignature",
      "msg": "Oracle report signature is invalid."
    },
    {
      "code": 6026,
      "name": "UnauthorizedOracleSigner",
      "msg": "Oracle report is signed by a node outside the feed's oracle set."
    },
    {
      "code": 6027,
      "name": "DuplicateOracleSigner",
      "msg": "Oracle report is signed twice by the same node."
    },
    {
      "code": 6028,
      "name": "WrongOracleState",
      "msg": "Oracle state account is not an allowed feed or does not match this market."
    },
    {
      "code": 6029,
      "name": "BadFeedAccount",
      "msg": "Feed account does not match this market's price feed."
    },
    {
      "code": 6030,
      "name": "FeedNotAllowed",
      "msg": "Price feed is not in the allowed feed list."
    },
    {
      "code": 6031,
      "name": "SnapshotFull",
      "msg": "Snapshot already holds sixteen entries."
    },
    {
      "code": 6032,
      "name": "SnapshotOutOfWindow",
      "msg": "Snapshot can only be taken within ten seconds of expiry."
    },
    {
      "code": 6033,
      "name": "SnapshotStale",
      "msg": "Snapshot landing counter must move forward."
    },
    {
      "code": 6034,
      "name": "UnableCompleteCheckout",
      "msg": "Reports are not adjacent rounds and are not certified by the market snapshot."
    },
    {
      "code": 6035,
      "name": "UnsupportedDecimals",
      "msg": "Feed decimals must be 8."
    }
  ],
  "types": [
    {
      "name": "CreateMarketParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "expiry",
            "type": "u64"
          },
          {
            "name": "marketId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "prediction",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "collateralAmount",
            "type": "u64"
          },
          {
            "name": "threshold",
            "type": "i64"
          },
          {
            "name": "settleAbove",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "EpochRound",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "u32"
          },
          {
            "name": "round",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "LpPosition",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "i128"
          },
          {
            "name": "checkpointYes",
            "type": "i128"
          },
          {
            "name": "checkpointNo",
            "type": "i128"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "Market",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "expiry",
            "type": "u64"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "yesMint",
            "type": "pubkey"
          },
          {
            "name": "noMint",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "MarketStatus"
              }
            }
          },
          {
            "name": "collateralMint",
            "type": "pubkey"
          },
          {
            "name": "winner",
            "type": {
              "option": {
                "defined": {
                  "name": "MarketOutcome"
                }
              }
            }
          },
          {
            "name": "marketCollateralBump",
            "type": "u8"
          },
          {
            "name": "prediction",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "finishTs",
            "type": "u64"
          },
          {
            "name": "lZero",
            "type": "i128"
          },
          {
            "name": "lastAccrualTs",
            "type": "i64"
          },
          {
            "name": "cumYesPerShare",
            "type": "i128"
          },
          {
            "name": "cumNoPerShare",
            "type": "i128"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "reserveYes",
            "type": "i128"
          },
          {
            "name": "reserveNo",
            "type": "i128"
          },
          {
            "name": "totalLpShares",
            "type": "i128"
          },
          {
            "name": "endTs",
            "type": "i64"
          },
          {
            "name": "ocr2State",
            "type": "pubkey"
          },
          {
            "name": "threshold",
            "type": "i64"
          },
          {
            "name": "decimals",
            "type": "u8"
          },
          {
            "name": "settleAbove",
            "type": "bool"
          },
          {
            "name": "settledPrice",
            "type": "i64"
          },
          {
            "name": "settledPublishTime",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "MarketOutcome",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "Yes"
          },
          {
            "name": "No"
          }
        ]
      }
    },
    {
      "name": "MarketSnapshot",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "entries",
            "type": {
              "vec": {
                "defined": {
                  "name": "Snapshot"
                }
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "MarketStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "Open"
          },
          {
            "name": "Resolved"
          },
          {
            "name": "WindowBurn"
          },
          {
            "name": "StaleBurn"
          }
        ]
      }
    },
    {
      "name": "ResolveMarketParam",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rawPre",
            "type": "bytes"
          },
          {
            "name": "rawPost",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "Snapshot",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "at",
            "type": {
              "defined": {
                "name": "EpochRound"
              }
            }
          },
          {
            "name": "counter",
            "type": "u32"
          },
          {
            "name": "price",
            "type": "i128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "SwapParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "minOut",
            "type": "u64"
          },
          {
            "name": "amountIn",
            "type": "u64"
          },
          {
            "name": "tokenType",
            "type": {
              "defined": {
                "name": "MarketOutcome"
              }
            }
          }
        ]
      }
    },
    {
      "name": "UserBetOnParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "minOut",
            "type": "u64"
          },
          {
            "name": "collateralAmount",
            "type": "u64"
          },
          {
            "name": "tokenType",
            "type": {
              "defined": {
                "name": "MarketOutcome"
              }
            }
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "CLAIM_WINDOW",
      "type": "u64",
      "value": "2592000"
    },
    {
      "name": "MAX_SETTLE_DELAY",
      "type": "i64",
      "value": "10"
    },
    {
      "name": "RESOLVE_WINDOW",
      "type": "u64",
      "value": "172800"
    },
    {
      "name": "SERVICE_FEE",
      "type": "u64",
      "value": "30"
    }
  ]
};

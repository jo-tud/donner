// Minimal HTML entity decoder (Latin-1 + common typography), no dependencies.

const NAMED = Object.create(null);
for (const pair of "AElig:198,Aacute:193,Acirc:194,Agrave:192,Aring:197,Atilde:195,Auml:196,Ccedil:199,Dagger:8225,ETH:208,Eacute:201,Ecirc:202,Egrave:200,Euml:203,Iacute:205,Icirc:206,Igrave:204,Iuml:207,Ntilde:209,OElig:338,Oacute:211,Ocirc:212,Ograve:210,Oslash:216,Otilde:213,Ouml:214,Prime:8243,Scaron:352,THORN:222,Uacute:218,Ucirc:219,Ugrave:217,Uuml:220,Yacute:221,Yuml:376,aacute:225,acirc:226,acute:180,aelig:230,agrave:224,amp:38,aring:229,atilde:227,auml:228,bdquo:8222,brvbar:166,bull:8226,ccedil:231,cedil:184,cent:162,circ:710,copy:169,curren:164,dagger:8224,darr:8595,deg:176,divide:247,eacute:233,ecirc:234,egrave:232,emsp:8195,ensp:8194,eth:240,euml:235,euro:8364,fnof:402,frac12:189,frac14:188,frac34:190,ge:8805,gt:62,harr:8596,hellip:8230,iacute:237,icirc:238,iexcl:161,igrave:236,infin:8734,iquest:191,iuml:239,laquo:171,larr:8592,ldquo:8220,le:8804,lrm:8206,lsaquo:8249,lsquo:8216,lt:60,macr:175,mdash:8212,micro:181,middot:183,minus:8722,nbsp:160,ndash:8211,ne:8800,not:172,ntilde:241,oacute:243,ocirc:244,oelig:339,ograve:242,ordf:170,ordm:186,oslash:248,otilde:245,ouml:246,para:182,permil:8240,plusmn:177,pound:163,prime:8242,quot:34,raquo:187,rarr:8594,rdquo:8221,reg:174,rlm:8207,rsaquo:8250,rsquo:8217,sbquo:8218,scaron:353,sect:167,shy:173,sup1:185,sup2:178,sup3:179,szlig:223,thinsp:8201,thorn:254,tilde:732,times:215,trade:8482,uacute:250,uarr:8593,ucirc:251,ugrave:249,uml:168,uuml:252,yacute:253,yen:165,yuml:255,zwj:8205,zwnj:8204".split(",")) {
  const i = pair.indexOf(":");
  NAMED[pair.slice(0, i)] = Number(pair.slice(i + 1));
}
NAMED.apos = 39;
// HTML5 punctuation entities (used to obfuscate CSS such as "display&colon;none").
Object.assign(NAMED, { colon: 58, semi: 59, lpar: 40, rpar: 41, sol: 47, bsol: 92, num: 35, excl: 33, quest: 63, period: 46, comma: 44, lowbar: 95, equals: 61, plus: 43, dollar: 36, percnt: 37, ast: 42, commat: 64, lsqb: 91, rsqb: 93, lcub: 123, rcub: 125, verbar: 124, grave: 96, Hat: 94, NewLine: 10, Tab: 9, nbsp: 160, zwsp: 8203 });

export function decodeEntities(s) {
  if (!s || s.indexOf("&") === -1) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (m, ent) => {
    let cp;
    if (ent[0] === "#") {
      cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    } else {
      cp = NAMED[ent];
      if (cp === undefined) return m;
    }
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\ufffd";
    return String.fromCodePoint(cp);
  });
}

# donner – Schnellstart (Deutsch)

donner ist eine lokale Such-Schicht für thunderbird-cli: ein SQLite-Volltextindex deiner
Thunderbird-Mails. Du und deine KI-Agenten können damit in Millisekunden suchen, lesen, zählen und
auswerten, auch in PDF-Anhängen. donner schreibt nie in Thunderbird. Aktionen wie Antworten,
Verschieben oder Löschen bleiben bei `tb`.

## Voraussetzungen

- Node.js ≥ 22.13
- Thunderbird 128+ mit thunderbird-cli: Add-on „Thunderbird AI Bridge“ und `tb-bridge`
- Empfohlen: `pdftotext` (Paket `poppler-utils`), damit Text aus PDF-Anhängen zuverlässig gefunden wird

## Installation

Thunderbird muss laufen und [thunderbird-cli](https://github.com/vitalio-sh/thunderbird-cli#quick-start) eingerichtet sein. Dann:

```bash
npm install -g donner-mail
donner setup
```

`donner setup` erledigt alles in einem Schritt:
- prüft die Verbindung zu Thunderbird (und ob `pdftotext` installiert ist),
- trägt donner in **Claude Desktop** und **Claude Code** ein (andere Einstellungen bleiben erhalten; die alte Datei wird als `.bak` gesichert),
- installiert den Skill für Claude Code,
- baut den Index auf (beim ersten Mal dauert das; Strg-C ist sicher, es geht später weiter),
- fragt nach Adressen, die unter deinem Namen senden, aber noch nicht bekannt sind,
- richtet einen Hintergrunddienst ein, der den Index aktuell hält.

Danach Claude Desktop neu starten.

**Aktualisieren:** `npm install -g donner-mail@latest`, danach wieder `donner setup`.
**Entfernen:** `donner uninstall` (mit `--purge --yes` auch Index und Config), dann `npm uninstall -g donner-mail`.

## Erste Schritte

```bash
donner search rechnung from:stadtwerke after:2025-01
donner show 1234
donner thread 1234
donner status          # was ist im Index, letzter Sync, deine Adressen
donner doctor          # falls etwas nicht stimmt
```

## Suchsprache (Auswahl)

| Beispiel | Bedeutung |
|---|---|
| `rechnung stadtwerke` | alle Wörter, Präfixsuche (`rechnung` findet „Rechnungsnummer“) |
| `"genaue phrase"` | exakte Phrase |
| `(from:anna OR to:anna) budget` | Gruppen; OR bindet stärker als UND |
| `-newsletter`, `-from:noreply`, `NOT newsletter` | ausschließen |
| `from:müller`, `with:björn` | Personen (`müller` = `mueller`, Groß-/Kleinschreibung egal) |
| `from:me` | alle eigenen Adressen (alle Identitäten, Absender in Gesendet-Ordnern, `index.myAddresses`); `donner doctor` schlägt weitere vor |
| `has:pdf`, `filename:angebot` | Anhänge |
| `has:invite`, `has:event`, `has:cancelled` | Einladungen mit Antwort · alles mit Termin (auch Arzttermine, Tickets) · Absagen |
| `in:inbox`, `folder:Privat/Rechnungen`, `account:Firma` | Ort |
| `after:2025-01 before:2025-07`, `newer_than:30d` | Datum (`before` ist exklusiv) |
| `since:2025-01 until:2025-03` | Zeitraum einschließlich März |
| `is:unread`, `is:suspicious`, `is:hidden` | Status; verdächtig = Absenderprüfung (DMARC) fehlgeschlagen oder versteckter Text von Unbekannten |

Umlaute: `müller` und `mueller` finden dasselbe, ebenso `straße` und `strasse`; `muller` ist ein
anderes Wort. Es gibt keine Wortstamm-Suche. Deutsche Komposita werden nur über den Wortanfang gefunden
(`suchindex` findet „Suchindex“, `index` nicht). Hilfreich sind Wortstämme (`verzög`) oder
`rechnung OR invoice`.

## Komplexe Fragen

```bash
donner count has:pdf rechnung --by month      # Rechnungen pro Monat
donner people -n 10                            # wer schreibt mir am meisten
donner people björn                            # last_received / last_sent
donner threads lieferverzug                    # Diskussionen zu einem Thema (Beginn, Ende, Beteiligte)
donner threads --min 4 --mine                  # lange Konversationen, an denen ich beteiligt war
donner threads with:björn --sort first         # alle Konversationen mit einer Person
donner count --by year,direction               # gesendet/empfangen pro Jahr
donner search 'has:event event_after:today' --sort event    # kommende Termine, nächster zuerst
donner sql "SELECT …"                          # alles Weitere, nur lesend (siehe: donner schema)
```

## Mit KI-Agenten

- `donner setup` hat donner in Claude Desktop und Claude Code eingetragen und den Skill installiert.
- **Aktionen:** Erst `donner resolve <id>` aufrufen, das liefert die aktuelle Thunderbird-ID. Dann damit `tb reply …`, `tb move …` usw. Den MCP-Server von thunderbird-cli dafür aktiviert lassen.

## Datenschutz

- **Speicherort:** Der Index liegt unter `~/.local/share/donner/` (Linux) bzw. `~/Library/Application Support/donner/` (macOS), mit den Rechten 0600.
- **Ausgeschlossen:** Spam und Papierkorb werden standardmäßig nicht indexiert, auch verschachtelte Ordner wie `+spamverdacht`.
- **Löschungen:** In Thunderbird gelöschte Mails verschwinden beim nächsten Sync aus dem Index.
- **Netzwerk:** Außer zur lokalen Bridge baut donner keine Verbindungen auf.
- **Löschen des Index:** `donner reset --yes`.

Mehr Details: [README](../../README.md) (Englisch).

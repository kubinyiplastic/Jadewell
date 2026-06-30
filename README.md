# JadeWell — Szerviz menedzsment rendszer

Webalkalmazás a JadeWell medence és szauna kivitelező cég számára.
Két különálló felület: szervizes (mobiloptimalizált) és admin.

> **v1.0.2 — javított verzió**: a `better-sqlite3` lecserélve a Node.js **beépített** `node:sqlite` moduljára. Ez azt jelenti, hogy **NEM kell Visual Studio-t telepíteni Windows-ra**, és a `npm install` egyszerűen lefut. **Node.js 22.5 vagy újabb** szükséges (a Te `v24.15.0`-ad tökéletes).

## Mire képes?

### Szervizes felület (telefonon vagy gépen)
- Bejelentkezés saját felhasználónévvel
- Új munka rögzítése: partner, dátum, érkezés/távozás idő, szerelők neve, elvégzett munka, beépített anyagok
- Képek feltöltése a munkához (telefonnal fotózás közvetlenül feltölthető)
- Saját korábbi munkák listázása, év/hónap szűréssel

### Admin felület (csak Te)
- **Áttekintés**: összes munka száma, partnerek száma, havi munkák, nem számlázott munkák száma és összege
- **Munkák**: dátum, partner, hónap, év, szerelő, számlázási státusz alapján szűrhető
- **Partnerek**: hozzáadás, módosítás, törlés
- **Felhasználók kezelése**: szervizesek és további adminok felvitele
- **PDF riportok**: partnerenként riport készítése, év/hónap/számlázási státusz szerint szűrhetően

---

## Lépésről lépésre — telepítés és indítás

### 1. Node.js telepítése (egyszer)

**FONTOS: Node.js 22.5 vagy újabb szükséges.** Ha már van Node.js telepítve, ellenőrizd:
```
node --version
```
Ha a verzió alacsonyabb mint v22.5, frissítsd. A Te logodon `v24.15.0` van — ez tökéletes.

Telepítés:
1. Nyisd meg: https://nodejs.org
2. Töltsd le az **LTS** verziót (a bal oldali zöld gomb)
3. Telepítsd alapbeállításokkal — kattintgasd a "Next"-eket

### 2. Régi telepítés tisztítása (ha volt korábbi próbálkozás)

Ha már próbáltad telepíteni a régi verziót és kaptál Visual Studio hibát, **töröld** a régi mappa tartalmából a `node_modules` mappát és a `package-lock.json` fájlt:

**Windowson** (PowerShell):
```
cd C:\Users\Home\Documents\JadeWell
rmdir /s /q node_modules
del package-lock.json
```

**Vagy egyszerűen Explorer-ben**: töröld a `node_modules` mappát és a `package-lock.json` fájlt (ha van).

Aztán cseréld ki ezt az új verziót a régi mappa fölé.

### 3. Csomagok telepítése

Nyiss egy terminált **a `jadewell-app` mappában**.

**Windowson**: nyisd meg az Explorer-ben a `jadewell-app` mappát, kattints a címsorba, írd be `cmd`, és nyomj Enter-t.

**macOS-en**: Finder → jobb klikk a mappán → "Új terminál a mappánál".

```
npm install
```
Ez most **csak 7 tiszta JavaScript csomagot** telepít, és gyors. **Visual Studio NEM kell.**

### 4. Az első admin felhasználó létrehozása

Ugyanabban a terminálban:
```
npm run init-db
```

A program kérdez:
- Nevedet
- Felhasználónevet (pl. `andras`)
- Jelszót (legalább 6 karakter)

Utána megkérdezi, hogy szeretnél-e szervizeseket is felvenni — válaszolj `i`-vel ha igen, és vidd fel őket. Később az admin felületen is hozzáadhatsz újakat.

### 5. A szerver elindítása

```
npm start
```

A terminálban ezt kell látnod:
```
╔══════════════════════════════════════════╗
║       JadeWell szerviz rendszer          ║
╚══════════════════════════════════════════╝

  Szervizes felület:  http://localhost:3000
  Admin felület:      http://localhost:3000/admin
```

Most a böngésződből megnyithatod ezt a két címet **a saját gépeden**. A szerver akkor működik, amíg a terminált nem zárod be.

### 6. Online elérhetővé tétel — ngrok

Hogy a szervizesek **bárhonnan, telefonjukról** is elérjék:

#### ngrok telepítése (egyszer)

1. Menj: https://ngrok.com/download
2. Töltsd le a saját rendszeredre
3. Csomagold ki egy állandó helyre (pl. `C:\ngrok\ngrok.exe`)
4. Regisztrálj ingyen a https://dashboard.ngrok.com/signup oldalon
5. A bejelentkezés után másold ki a saját **authtoken**-edet a "Your Authtoken" oldalról
6. Egyszer futtasd a parancssorban (csak első alkalommal):
   ```
   ngrok config add-authtoken IDE_MASOLD_A_TOKENED
   ```

#### ngrok napi indítása

Két terminált nyiss meg:

**1. terminál — szerver indítása:**
```
cd jadewell-app
npm start
```

**2. terminál — ngrok indítása:**
```
ngrok http 3000
```

Az ngrok terminálja egy ilyen sort fog mutatni:
```
Forwarding   https://valami-szam.ngrok-free.app -> http://localhost:3000
```

**Ezt a `https://valami-szam.ngrok-free.app` URL-t** küldd el a szervizeseknek. Ezen érik el a szervizes felületet, a `/admin` végződéssel pedig te az admin felületet.

> **Figyelem**: az ingyenes ngrok minden indításnál ad egy új URL-t. Ha ez zavaró, fizetős verzióval (~$8/hó) kapsz állandó címet (pl. `jadewell.ngrok.app`).

### 7. Napi használat — gyors útmutató

Reggel:
1. Indítsd el a gépet, nyisd meg a `jadewell-app` mappát
2. Két terminál: az egyikben `npm start`, a másikban `ngrok http 3000`
3. Másold ki az ngrok URL-jét és küldd el a kollégáknak (csak ha új)

A szervizesek ma:
1. Megnyitják az URL-t telefonon
2. Bejelentkeznek
3. Új munka → partner választás → érkezési idő, távozási idő, mit csináltak, mit építettek be → fotók → mentés

Te este:
1. Megnyitod az `/admin` címet
2. Áttekintés: ki mit csinált
3. Bejelölöd melyik munka lett kiszámlázva
4. PDF riport partnerenként

---

## Mappastruktúra

```
jadewell-app/
├── server.js              ← szerver indítása
├── package.json           ← csomagleíró
├── .env                   ← jelszavak, titkos kulcsok
├── jadewell.db            ← adatbázis (automatikusan létrejön)
├── database/
│   └── db.js              ← adatbázis séma (node:sqlite használatával)
├── routes/                ← API logika
├── middleware/            ← hitelesítés
├── scripts/
│   └── init-users.js      ← első admin létrehozása
├── public/
│   ├── index.html         ← szervizes felület
│   └── admin.html         ← admin felület
└── uploads/               ← feltöltött képek
```

---

## Adatbiztonság

- A jelszavak **bcrypt-tel titkosítva** kerülnek tárolásra (nem visszaolvashatók)
- A bejelentkezés **JWT tokent** használ, 30 napig érvényes
- **Az `.env` fájlban lévő `JWT_SECRET` értéket változtasd meg** valami hosszú véletlen szövegre (csak Te ismerd)!
- A `jadewell.db` fájlt rendszeresen mentsd el, mert ebben van az összes adat

### Mit ments el rendszeresen?

```
jadewell.db          ← teljes adatbázis
uploads/             ← összes fotó
```

Ez a két dolog elég ahhoz, hogy bármikor visszaállítsd a rendszert.

---

## Hibaelhárítás

**"Cannot find module 'node:sqlite'"** vagy "node:sqlite is not available" → a Node.js verzió túl régi. Frissítsd Node 22.5+-ra.

**"Port 3000 is in use"** → vagy más alkalmazás használja, vagy korábban már fut. Vagy állítsd át a `.env`-ben a portot, vagy zárd be a másikat.

**Elfelejtettem az admin jelszavam** → futtasd újra `npm run init-db` és válaszolj `i`-vel az "új admin" kérdésre, vagy lépj be egy meglévő admin felhasználóval és állítsd vissza.

**A telefonon nem jön be a kamera** → az ngrok HTTPS-t biztosít, így a böngésző engedi a kamerát. Ha mégsem, ellenőrizd a böngésző engedélyeit.

---

## Fejlesztői mód (opcionális)

Ha módosítod a kódot és szeretnéd hogy automatikusan újrainduljon:
```
npm run dev
```

---

Sok sikert!

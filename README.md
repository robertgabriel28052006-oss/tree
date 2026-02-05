# Spalatorie Camin - Backend Python

Acest proiect a fost actualizat pentru a folosi un backend securizat în Python (Flask) pentru a proteja parola de administrator și a ascunde PIN-urile rezervărilor.

## 🛠️ Cerințe

*   Python 3.8+
*   Un cont Firebase activ

## 🚀 Instalare și Configurare

### 1. Instalare Dependințe
Deschide terminalul în folderul proiectului și rulează:

```bash
pip install -r requirements.txt
```

### 2. Configurare Firebase (Critic!)
Pentru ca serverul să poată comunica cu baza de date, ai nevoie de o "Cheie de Serviciu" (Service Account Key). Aceasta nu trebuie să fie niciodată publică!

1.  Mergi în **Firebase Console** -> **Project Settings** (rotița dințată).
2.  Tab-ul **Service accounts**.
3.  Click pe **Generate new private key**.
4.  Se va descărca un fișier JSON.
5.  Redenumește-l în `serviceAccountKey.json` și pune-l în acest folder (lângă `app.py`).

### 3. Configurare Administrator
Aplicația folosește variabile de mediu sau valori implicite.

*   **Email Admin Implicit:** `admin@spalatorie.com`
*   **Parola Implicită:** `p20spal`

Dacă vrei să le schimbi, creează un fișier `.env` în folderul proiectului:

```ini
ADMIN_EMAIL=adminul_tau@exemplu.com
# Parola trebuie să fie un hash (vezi mai jos cum generezi unul)
ADMIN_PASSWORD_HASH=scrypt:32768:8:1$....
SECRET_KEY=o_cheie_secreta_foarte_lunga_si_aleatorie
```

#### Cum generez un hash nou pentru parolă?
Poți folosi acest mic script Python:

```python
from werkzeug.security import generate_password_hash
print(generate_password_hash("parola_ta_noua"))
```
Copiază rezultatul și pune-l în `.env` la `ADMIN_PASSWORD_HASH`.

## ▶️ Pornire Aplicație

Pentru a rula serverul local:

```bash
python app.py
```

Serverul va porni la adresa `http://localhost:5000`.

## 📦 Despre Securitate

*   **Admin Firewall:** Autentificarea se face acum pe server. Parola nu mai ajunge niciodată în browser-ul clientului.
*   **PIN-uri Ascunse:** PIN-urile sunt "hash-uite" (criptate ireversibil) înainte de a fi salvate. Când se încarcă orarul, serverul șterge câmpul `code` din datele trimise către browser, deci nimeni nu poate vedea PIN-urile altora, nici măcar dacă se uită în "Network Tools".
*   **Ștergere:** Ștergerea unei rezervări verifică PIN-ul pe server.

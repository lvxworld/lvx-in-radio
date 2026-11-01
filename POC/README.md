# LVX Radio — macOS HTML prototype

Apri **LVX Radio macOS Prototype.html** con un doppio clic, oppure dal terminale:

```sh
open "POC/LVX Radio macOS Prototype.html"
```

Il file è autonomo: font, logo e runtime sono incorporati. Non richiede installazione, server o connessione a Internet.

- **Create**: gira o clicca le manopole Scenario, Sound DNA ed Energy. Il centro di Sound DNA attiva/disattiva il genere. Le quattro manopole hanno la stessa dimensione: Scenario e Sound DNA occupano le prime due colonne; Energy e Tune In sono impilati nella terza. Sotto Scenario trovi Vocals e Describe, sempre aperto e modificabile solo con la voce attiva. La textarea termina alla stessa altezza del pannello DNA. Il mix ha cinque slot fissi: le posizioni vuote sono grigie e riportano NO SIGNAL; selezionando un genere si attiva uno slot, deselezionandolo si libera la sua posizione senza spostare gli altri. Ogni cursore indica la percentuale effettiva: spostandone uno, gli altri si aggiornano proporzionalmente, comprese tacche e indicatori, mantenendo il totale al 100%. Con un solo genere, il cursore resta acceso e bloccato al 100%; aggiungendo un secondo genere, il mix torna modificabile.
- **Tune in**: è sotto Energy nella terza colonna, al centro della manopola Direct / Melody / Full Score. Clicca le etichette, trascina la corona oppure usa Tab e frecce per selezionare una modalità. Il pulsante centrale avvia la sintonizzazione e l'audio sintetizzato della demo. Le modalità sono selezioni del prototipo: il loro significato musicale sarà definito in seguito.
- **Colori e movimento**: ogni genere ha un colore coerente tra manopola e percentuali; gli otto scenari hanno accenti distinti. Direct usa ambra, Melody salvia e Full Score malva, anche sul pulsante centrale. Le manopole hanno un leggero respiro luminoso e tacche animate. Il movimento decorativo rispetta la preferenza di sistema per ridurre le animazioni.
- **On air**: In tune with you, timeline e Transmitter sono allineati nella parte superiore delle tre colonne, con quadrante e Steer sotto i rispettivi pannelli. Il player più compatto rimane in basso a tutta larghezza, con indietro, Play/Pausa, avanti, preferiti, feedback e volume. Indietro ricomincia il brano dopo tre secondi; altrimenti seleziona il brano precedente della timeline.
- **Station timeline**: ogni frequenza conserva il suo elenco ordinato, il brano selezionato e la posizione di ascolto. Le canzoni già ascoltate restano visibili accanto a quelle pronte, in generazione e in attesa. Selezionare un brano cambia il player senza rimuovere o riordinare le righe. Tornando su una frequenza si ritrova lo storico della sessione.
- **Cuori per canzone**: ogni brano pronto ha un cuore indipendente dalla selezione, sincronizzato con quello del player. L'identità del brano è distinta dal titolo e dalla stazione, anche quando i titoli della demo si ripetono. In memoria sono conservati eventi like/unlike/dislike, ID di brano e stazione, timestamp e configurazione di generazione (mix, energia, BPM, voce, modalità e prompt). Sono dati preparatori per analisi future, senza una dashboard analitica.
- **Generazione dimostrativa**: gli avanzamenti e le canzoni della timeline sono simulati, senza motore esterno né file audio generati. Storico e feedback restano in memoria e si azzerano ricaricando la pagina.
- **Funzioni rimandate**: Your signal e i pulsanti delle statistiche di ascolto sono temporaneamente nascosti per concentrarsi su Create e On air.
- **Menu bar**, pulsante rosso o giallo: nasconde la finestra e apre il pannello in alto a destra. L'audio prosegue. **Show LVX Radio** riapre la finestra.
- **Pulsante verde**: alterna la larghezza della finestra.
- **Tastiera**: Spazio avvia/mette in pausa; Esc chiude il pannello. Le manopole supportano Tab e frecce; Invio attiva il genere o applica Steer.

La barra macOS e i controlli finestra sono simulati all'interno della pagina. È una prova dell'interfaccia, senza integrazione nativa o motore esterno. Lo stato resta in memoria e si azzera ricaricando.

Il riferimento originale **LVX Radio v2.html** è conservato senza modifiche.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { prisma } from '@/lib/prisma';

/**
 * Verifica la sessione dell'utente autenticato.
 */
async function getAuthenticatedUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get('session_token');

  if (!token) {
    return {
      error: NextResponse.json(
        { success: false, error: 'Autenticazione richiesta.' },
        { status: 401 }
      )
    };
  }

  try {
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      throw new Error('JWT_SECRET non configurato');
    }

    const decoded = jwt.verify(token.value, secret);

    if (!decoded.id) {
      throw new Error('Token senza ID utente');
    }

    const user = await prisma.utente.findUnique({
      where: { id_utente: decoded.id },
      select: { id_utente: true }
    });

    if (!user) {
      return {
        error: NextResponse.json(
          { success: false, error: 'Utente non trovato.' },
          { status: 401 }
        )
      };
    }

    return { userId: user.id_utente };

  } catch (error) {
    return {
      error: NextResponse.json(
        { success: false, error: 'Sessione non valida.' },
        { status: 401 }
      )
    };
  }
}

/**
 * Verifica se l'utente può accedere alle terapie di un assistito.
 *
 * Proprietario: accesso completo.
 * Caregiver ADMIN: lettura e scrittura.
 * Caregiver SOLO_LETTURA: sola lettura.
 * Caregiver NIENTE: nessun accesso.
 */
async function checkPatientPermission(userId, patientId, requireWrite = false) {
  // L'assistito può gestire le proprie terapie.
  if (userId === patientId) {
    return { authorized: true, permission: 'OWNER' };
  }

  // Verifica la relazione tra caregiver e assistito.
  const relazione = await prisma.relazione.findFirst({
    where: {
      id_caregiver: userId,
      id_assistito: patientId
    },
    select: {
      permessi_piano: true
    }
  });

  if (!relazione) {
    return { authorized: false };
  }

  const permission = relazione.permessi_piano;

  if (permission === 'NIENTE') {
    return { authorized: false };
  }

  if (requireWrite && permission !== 'ADMIN') {
    return { authorized: false };
  }

  return {
    authorized: true,
    permission
  };
}

/**
 * GESTIONE POST: Registra una nuova assunzione (o mancata assunzione)
 * Supporta due modalità operative:
 * 1. Pianificazione Massiva: Genera automaticamente le assunzioni future basandosi su data inizio/fine e orari.
 * 2. Inserimento Singolo: Registra un evento specifico (utile per terapie "al bisogno" o aggiustamenti manuali).
 */

export async function POST(request) {
  try {
    // 1. Verifica autenticazione
    const auth = await getAuthenticatedUser();

    if (auth.error) {
      return auth.error;
    }

    const body = await request.json();
    const {
      id_terapia,
      data_inizio,
      data_fine,
      orari,
      data_programmata,
      orario_effettivo,
      esito
    } = body;

    // 2. Validazione
    if (!id_terapia) {
      return NextResponse.json(
        { success: false, error: "Dati mancanti: id_terapia." },
        { status: 400 }
      );
    }

    // 3. Recupera la terapia e verifica i permessi sul paziente
    const terapia = await prisma.piano_terapeutico.findUnique({
      where: { id_terapia: id_terapia },
      select: {
        id_terapia: true,
        id_paziente: true,
        id_farmaco_armadietto: true,
        dose_singola: true
      }
    });

    if (!terapia) {
      return NextResponse.json(
        { success: false, error: "Terapia non trovata." },
        { status: 404 }
      );
    }

    const permission = await checkPatientPermission(
      auth.userId,
      terapia.id_paziente,
      true
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: "Non hai i permessi per modificare questa terapia." },
        { status: 403 }
      );
    }

    // 4. Array per raccogliere le assunzioni create
    const assunzioniCreate = [];

    // --- CASO 1: Generazione massiva ---
    if (data_inizio && Array.isArray(orari) && orari.length > 0) {
      let currDate = new Date(data_inizio);
      let endDate;

      if (data_fine) {
        endDate = new Date(data_fine);
      } else {
        // Terapia senza data di fine: genera i primi 30 giorni
        endDate = new Date(data_inizio);
        endDate.setDate(endDate.getDate() + 30);
      }

      while (currDate <= endDate) {
        const dataStr = currDate.toISOString().split('T')[0];

        for (const orario of orari) {
          const dataProgrammataFinale = new Date(`${dataStr}T${orario}:00Z`);

          const nuovaAssunzione = await prisma.registro_assunzioni.create({
            data: {
              terapia: {
                connect: {
                  id_terapia: id_terapia
                }
              },
              data_programmata: dataProgrammataFinale,
              orario_effettivo: null,
              esito: null
            }
          });

          assunzioniCreate.push(nuovaAssunzione);
        }

        currDate.setDate(currDate.getDate() + 1);
      }
    }

    // --- CASO 2: Inserimento singolo ---
    else if (data_programmata) {
      // Verifica disponibilità nell'armadietto
      if (esito === true && terapia.id_farmaco_armadietto) {
        const farmacoInfo = await prisma.farmaco_armadietto.findUnique({
          where: {
            id_farmaco_armadietto: terapia.id_farmaco_armadietto
          }
        });

        if (
          farmacoInfo &&
          farmacoInfo.quantita_rimanente < terapia.dose_singola
        ) {
          return NextResponse.json(
            { success: false, error: "Farmaco esaurito" },
            { status: 400 }
          );
        }
      }

      // Crea l'assunzione
      const singolaAssunzione = await prisma.registro_assunzioni.create({
        data: {
          id_terapia: id_terapia,
          data_programmata: new Date(data_programmata),
          orario_effettivo: orario_effettivo
            ? new Date(orario_effettivo)
            : null,
          esito: esito !== undefined ? Boolean(esito) : null
        },
        include: {
          terapia: true
        }
      });

      assunzioniCreate.push(singolaAssunzione);

      // Scala la quantità se l'assunzione è confermata
      if (
        singolaAssunzione.esito === true &&
        terapia.id_farmaco_armadietto
      ) {
        await prisma.farmaco_armadietto.update({
          where: {
            id_farmaco_armadietto: terapia.id_farmaco_armadietto
          },
          data: {
            quantita_rimanente: {
              decrement: terapia.dose_singola
            }
          }
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: `Create ${assunzioniCreate.length} assunzioni correttamente.`,
      data: assunzioniCreate
    }, { status: 201 });

  } catch (error) {
    console.error("Errore registrazione assunzione:", error);

    if (error.code === 'P2003') {
      return NextResponse.json(
        { success: false, error: "Errore: Terapia non valida." },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { success: false, error: "Errore interno durante il salvataggio delle assunzioni." },
      { status: 500 }
    );
  }
}


/**
 * GESTIONE GET: Recupera lo storico delle assunzioni
 * Include una logica di "pulizia automatica": verifica le assunzioni scadute da oltre 3 ore,
 * le segna come non assunte (esito: false) e tenta di riprogrammarle in coda.
 */

export async function GET(request) {
  try {
    // 1. Verifica autenticazione
    const auth = await getAuthenticatedUser();

    if (auth.error) {
      return auth.error;
    }

    const { searchParams } = new URL(request.url);

    const id_utente = searchParams.get('id_utente');
    const id_terapia = searchParams.get('id_terapia');
    const id_evento = searchParams.get('id_evento');
    const data_inizio = searchParams.get('data_inizio');
    const data_fine = searchParams.get('data_fine');
    const data_programmata = searchParams.get('data_programmata');

    if (!id_utente) {
      return NextResponse.json(
        { success: false, error: "ID utente obbligatorio" },
        { status: 400 }
      );
    }

    // 2. Verifica permessi sul paziente richiesto
    const permission = await checkPatientPermission(
      auth.userId,
      id_utente,
      false
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: "Non autorizzato ad accedere a queste assunzioni." },
        { status: 403 }
      );
    }

    // 3. Costruisce il filtro per limitare le operazioni
    // esclusivamente alle terapie dell'assistito autorizzato.
    const terapiaFilter = {
      id_paziente: id_utente
    };

    if (id_terapia) {
      terapiaFilter.id_terapia = id_terapia;
    }

    if (id_evento) {
      const evento = await prisma.registro_assunzioni.findFirst({
        where: {
          id_evento,
          terapia: terapiaFilter
        },
        select: { id_evento: true }
      });

      if (!evento) {
        return NextResponse.json(
          { success: false, error: "Assunzione non trovata." },
          { status: 404 }
        );
      }
    }

    // 4. Pulizia automatica delle assunzioni scadute.
    // Mantiene la soglia originale di 3 ore e limita l'elaborazione
    // alle terapie dell'assistito autorizzato.
    // SOLO_LETTURA può consultare, ma non attivare modifiche automatiche.
    if (permission.permission !== 'SOLO_LETTURA') {
      const threeHoursAgo = new Date(
        Date.now() - 3 * 60 * 60 * 1000
      );

      const assunzioniScadute = await prisma.registro_assunzioni.findMany({
        where: {
          esito: null,
          data_programmata: {
            lt: threeHoursAgo
          },
          terapia: terapiaFilter
        },
        include: {
          terapia: true
        }
      });

      for (const assunzione of assunzioniScadute) {
        await prisma.registro_assunzioni.update({
          where: {
            id_evento: assunzione.id_evento
          },
          data: {
            esito: false
          }
        });

        await riprogrammaInCoda(
          assunzione.id_terapia,
          assunzione.terapia.orari
        );
      }
    }

    // 5. Costruzione dei filtri di lettura
    const filtri = {
      terapia: {
        id_paziente: id_utente
      }
    };

    if (id_terapia) {
      filtri.id_terapia = id_terapia;
    }

    if (id_evento) {
      filtri.id_evento = id_evento;
    }

    // 6. Filtro per data specifica
    if (data_programmata) {
      const dataTarget = new Date(data_programmata);

      if (Number.isNaN(dataTarget.getTime())) {
        return NextResponse.json(
          { success: false, error: "Data programmata non valida." },
          { status: 400 }
        );
      }

      const inizioGiorno = new Date(dataTarget);
      inizioGiorno.setHours(0, 0, 0, 0);

      const fineGiorno = new Date(dataTarget);
      fineGiorno.setHours(23, 59, 59, 999);

      filtri.data_programmata = {
        gte: inizioGiorno,
        lte: fineGiorno
      };
    }
    // 7. Filtro per intervallo di date
    else if (data_inizio || data_fine) {
      filtri.data_programmata = {};

      if (data_inizio) {
        filtri.data_programmata.gte = new Date(data_inizio);
      }

      if (data_fine) {
        filtri.data_programmata.lte = new Date(data_fine);
      }
    }

    // 8. Recupero assunzioni
    const assunzioni = await prisma.registro_assunzioni.findMany({
      where: filtri,
      orderBy: {
        data_programmata: 'desc'
      },
      include: {
        terapia: {
          include: {
            farmaco: {
              include: {
                farmaco: true
              }
            }
          }
        }
      }
    });

    return NextResponse.json({
      success: true,
      count: assunzioni.length,
      data: assunzioni
    }, { status: 200 });

  } catch (error) {
    console.error("Errore recupero assunzioni:", error);

    return NextResponse.json({
      success: false,
      error: "Errore interno durante il recupero dei dati."
    }, { status: 500 });
  }
}


/**
 * GESTIONE PUT: Aggiorna un'assunzione esistente
 * Gestisce la logica critica delle scorte: quando un'assunzione viene confermata,
 * scala la quantità dal farmaco corretto, cercando alternative se la scatola principale è vuota.
*/

export async function PUT(request) {
  try {
    // 1. Verifica autenticazione
    const auth = await getAuthenticatedUser();

    if (auth.error) {
      return auth.error;
    }

    const body = await request.json();
    const { id_evento, esito, orario_effettivo } = body;

    if (!id_evento) {
      return NextResponse.json(
        { success: false, error: "ID evento mancante." },
        { status: 400 }
      );
    }

    // 2. Recupera l'assunzione e la terapia collegata
    const currentAssunzione = await prisma.registro_assunzioni.findUnique({
      where: { id_evento: id_evento },
      include: {
        terapia: {
          include: { farmaco: true }
        }
      }
    });

    if (!currentAssunzione) {
      return NextResponse.json(
        { success: false, error: "Assunzione non trovata." },
        { status: 404 }
      );
    }

    // 3. Verifica i permessi sul paziente proprietario della terapia
    const permission = await checkPatientPermission(
      auth.userId,
      currentAssunzione.terapia.id_paziente,
      true
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: "Non hai i permessi per modificare questa assunzione." },
        { status: 403 }
      );
    }

    let boxToDecrementId = null;

    // 4. Gestione scorte: conferma di un'assunzione non ancora presa
    if (Boolean(esito) === true && currentAssunzione.esito !== true) {
      const farmaco = currentAssunzione.terapia.farmaco;
      const dose = currentAssunzione.terapia.dose_singola;

      if (!farmaco) {
        return NextResponse.json(
          { success: false, error: "Farmaco collegato alla terapia non trovato." },
          { status: 400 }
        );
      }

      boxToDecrementId = farmaco.id_farmaco_armadietto;

      // Controlla la quantità della scatola collegata
      if (farmaco.quantita_rimanente < dose) {
        // Cerca altre scatole dello stesso farmaco e proprietario
        const otherBoxes = await prisma.farmaco_armadietto.findMany({
          where: {
            id_utente_proprietario: farmaco.id_utente_proprietario,
            codice_aic: farmaco.codice_aic,
            quantita_rimanente: { gte: dose },
            id_farmaco_armadietto: {
              not: farmaco.id_farmaco_armadietto
            }
          },
          orderBy: {
            data_scadenza: 'asc'
          }
        });

        if (otherBoxes.length > 0) {
          boxToDecrementId = otherBoxes[0].id_farmaco_armadietto;
        } else {
          return NextResponse.json({
            success: false,
            error: "Quantità insufficiente nell'armadietto (tutte le scatole). Il farmaco è terminato."
          }, { status: 400 });
        }
      }
    }

    // 5. Prepara i dati da aggiornare
    const dataToUpdate = {};

    if (esito !== undefined) {
      dataToUpdate.esito = Boolean(esito);
    }

    if (orario_effettivo) {
      dataToUpdate.orario_effettivo = new Date(orario_effettivo);
    }

    const assunzioneAggiornata = await prisma.registro_assunzioni.update({
      where: { id_evento: id_evento },
      data: dataToUpdate
    });

    // 6. Scala le scorte dopo l'aggiornamento del registro
    if (currentAssunzione.esito !== true && Boolean(esito) === true) {
      await prisma.farmaco_armadietto.update({
        where: { id_farmaco_armadietto: boxToDecrementId },
        data: {
          quantita_rimanente: {
            decrement: currentAssunzione.terapia.dose_singola
          }
        }
      });
    }

    return NextResponse.json({
      success: true,
      message: "Assunzione aggiornata correttamente",
      data: assunzioneAggiornata
    }, { status: 200 });

  } catch (error) {
    console.error("Errore aggiornamento assunzione:", error);

    if (error.code === 'P2025') {
      return NextResponse.json(
        { success: false, error: "Assunzione non trovata." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: false,
      error: "Errore interno durante l'aggiornamento dell'assunzione."
    }, { status: 500 });
  }
}


/**
 * Funzione helper per riprogrammare un'assunzione in coda al piano terapeutico
 * Cerca l'ultimo slot occupato e ne crea uno nuovo successivo basandosi sugli orari della terapia.
 */
async function riprogrammaInCoda(id_terapia, orari) {
  // 1. Troviamo l'ultima assunzione pianificata per questa terapia
  const lastAssunzione = await prisma.registro_assunzioni.findFirst({
    where: { id_terapia: id_terapia },
    orderBy: { data_programmata: 'desc' }
  });

  // Procediamo solo se abbiamo una schedulazione valida e degli orari definiti
  if (lastAssunzione && Array.isArray(orari) && orari.length > 0) {
    // Ordiniamo gli orari per sicurezza (es. ["08:00", "20:00"])
    const sortedOrari = [...orari].sort();

    const lastDate = new Date(lastAssunzione.data_programmata);
    const lastH = lastDate.getUTCHours();
    const lastM = lastDate.getUTCMinutes();
    const lastTimeMins = lastH * 60 + lastM;

    let nextTimeStr = null;
    let addDay = false;

    // Cerchiamo il prossimo orario disponibile nello stesso giorno dell'ultima assunzione
    for (const o of sortedOrari) {
      const [h, m] = o.split(':').map(Number);
      const timeMins = h * 60 + m;
      if (timeMins > lastTimeMins) {
        nextTimeStr = o;
        break;
      }
    }

    // Se non troviamo un orario successivo nello stesso giorno, prendiamo il primo del giorno dopo
    if (!nextTimeStr) {
      nextTimeStr = sortedOrari[0];
      addDay = true;
    }

    // Calcoliamo la data della nuova assunzione
    const nextDate = new Date(lastDate);
    if (addDay) {
      nextDate.setDate(nextDate.getDate() + 1);
    }

    // Costruiamo la data ISO stringa (YYYY-MM-DD)
    const datePart = nextDate.toISOString().split('T')[0];
    // Costruiamo il timestamp completo UTC
    const newDataProgrammata = new Date(`${datePart}T${nextTimeStr}:00Z`);

    // Creiamo la nuova assunzione in coda
    await prisma.registro_assunzioni.create({
      data: {
        id_terapia: id_terapia,
        data_programmata: newDataProgrammata,
        esito: null, // Pending
        orario_effettivo: null
      }
    });
  }
}

/**
 * GESTIONE DELETE: Rimuove un'assunzione
 * - Se invocata con id_terapia: Archivia le assunzioni passate nello storico e pulisce quelle future.
 * - Se invocata con id_evento: Elimina la singola assunzione.
 */

export async function DELETE(request) {
  try {
    // 1. Verifica autenticazione
    const auth = await getAuthenticatedUser();

    if (auth.error) {
      return auth.error;
    }

    const { searchParams } = new URL(request.url);
    const id_evento = searchParams.get('id_evento');
    const id_terapia = searchParams.get('id_terapia');

    // CASO 1: Archiviazione massiva per terapia
    if (id_terapia) {
      // 2. Verifica che la terapia esista
      const terapia = await prisma.piano_terapeutico.findUnique({
        where: { id_terapia: id_terapia },
        select: { id_paziente: true }
      });

      if (!terapia) {
        return NextResponse.json(
          { success: false, error: "Terapia non trovata." },
          { status: 404 }
        );
      }

      // 3. Verifica permessi di modifica
      const permission = await checkPatientPermission(
        auth.userId,
        terapia.id_paziente,
        true
      );

      if (!permission.authorized) {
        return NextResponse.json(
          { success: false, error: "Non hai i permessi per modificare questa terapia." },
          { status: 403 }
        );
      }

      // 4. Trova le assunzioni completate
      const assunzioniDaSpostare = await prisma.registro_assunzioni.findMany({
        where: {
          id_terapia: id_terapia,
          esito: { not: null },
          orario_effettivo: { not: null }
        }
      });

      if (assunzioniDaSpostare.length > 0) {
        await prisma.$transaction(async (tx) => {
          // Copia nello storico
          await tx.registro_assunzioni_passate.createMany({
            data: assunzioniDaSpostare.map(a => ({
              id_terapia: a.id_terapia,
              data_programmata: a.data_programmata,
              orario_effettivo: a.orario_effettivo,
              esito: a.esito
            }))
          });

          // Elimina dalla tabella principale
          await tx.registro_assunzioni.deleteMany({
            where: {
              id_evento: {
                in: assunzioniDaSpostare.map(a => a.id_evento)
              }
            }
          });
        });
      } else {
        // Nessuna assunzione completata: elimina tutti i record
        await prisma.registro_assunzioni.deleteMany({
          where: {
            id_terapia: id_terapia
          }
        });
      }

      return NextResponse.json({
        success: true,
        message: `Archiviate ${assunzioniDaSpostare.length} assunzioni.`,
        count: assunzioniDaSpostare.length
      }, { status: 200 });
    }

    // CASO 2: Eliminazione singola per ID evento
    if (!id_evento) {
      return NextResponse.json(
        { success: false, error: "ID evento o ID terapia mancante." },
        { status: 400 }
      );
    }

    // 5. Recupera l'assunzione e la terapia collegata
    const assunzione = await prisma.registro_assunzioni.findUnique({
      where: { id_evento: id_evento },
      include: {
        terapia: {
          select: {
            id_paziente: true
          }
        }
      }
    });

    if (!assunzione) {
      return NextResponse.json(
        { success: false, error: "Assunzione non trovata." },
        { status: 404 }
      );
    }

    // 6. Verifica permessi di modifica
    const permission = await checkPatientPermission(
      auth.userId,
      assunzione.terapia.id_paziente,
      true
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: "Non hai i permessi per eliminare questa assunzione." },
        { status: 403 }
      );
    }

    await prisma.registro_assunzioni.delete({
      where: { id_evento: id_evento }
    });

    return NextResponse.json({
      success: true,
      message: "Assunzione eliminata con successo"
    }, { status: 200 });

  } catch (error) {
    console.error("Errore eliminazione/archiviazione assunzione:", error);

    if (error.code === 'P2025') {
      return NextResponse.json(
        { success: false, error: "Assunzione non trovata." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: false,
      error: "Errore interno durante l'eliminazione o l'archiviazione."
    }, { status: 500 });
  }
}
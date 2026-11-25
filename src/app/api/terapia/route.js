import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { prisma } from '@/lib/prisma';

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
    if (!secret) throw new Error('JWT_SECRET non configurato');

    const decoded = jwt.verify(token.value, secret);

    if (!decoded.id) throw new Error('Token senza ID utente');

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

async function checkPatientPermission(userId, patientId, requireWrite = false) {
  if (userId === patientId) {
    return { authorized: true, permission: 'OWNER' };
  }

  const relazione = await prisma.relazione.findFirst({
    where: {
      id_caregiver: userId,
      id_assistito: patientId
    },
    select: {
      permessi_piano: true
    }
  });

  if (!relazione || relazione.permessi_piano === 'NIENTE') {
    return { authorized: false };
  }

  if (requireWrite && relazione.permessi_piano !== 'ADMIN') {
    return { authorized: false };
  }

  return {
    authorized: true,
    permission: relazione.permessi_piano
  };
}

/**
 * GESTIONE POST: Crea un nuovo piano terapeutico
 * @param {Request} request - Contiene il corpo della terapia (id_paziente, id_farmaco_armadietto, ecc.)
 */

export async function POST(request) {
  try {
    // 1. Verifica autenticazione
    const auth = await getAuthenticatedUser();

    if (auth.error) {
      return auth.error;
    }

    // 2. Legge il corpo della richiesta
    const body = await request.json();

    const {
      id_paziente,
      id_farmaco_armadietto,
      nome_utilita,
      dose_singola,
      solo_al_bisogno,
      terapia_attiva,
      data_inizio,
      data_fine,
      note,
      orari
    } = body;

    // 3. Validazione dei campi obbligatori
    if (!id_paziente) {
      return NextResponse.json(
        { success: false, error: "Mancanza dell'ID del paziente." },
        { status: 400 }
      );
    }

    if (!id_farmaco_armadietto) {
      return NextResponse.json(
        { success: false, error: "Mancanza dell'ID del farmaco nell'armadietto." },
        { status: 400 }
      );
    }

    if (dose_singola === undefined || isNaN(parseFloat(dose_singola))) {
      return NextResponse.json(
        { success: false, error: "Dose singola non valida." },
        { status: 400 }
      );
    }

    // 4. Verifica i permessi sul paziente
    const permission = await checkPatientPermission(
      auth.userId,
      id_paziente,
      true
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: "Non hai i permessi per creare terapie per questo paziente." },
        { status: 403 }
      );
    }

    // 5. Verifica che il farmaco appartenga all'armadietto del paziente
    const farmaco = await prisma.farmaco_armadietto.findUnique({
      where: {
        id_farmaco_armadietto: id_farmaco_armadietto
      },
      select: {
        id_utente_proprietario: true
      }
    });

    if (!farmaco) {
      return NextResponse.json(
        { success: false, error: "Farmaco nell'armadietto non trovato." },
        { status: 404 }
      );
    }

    if (farmaco.id_utente_proprietario !== id_paziente) {
      return NextResponse.json(
        { success: false, error: "Il farmaco selezionato non appartiene all'armadietto del paziente." },
        { status: 403 }
      );
    }

    // 6. Creazione del piano terapeutico
    const nuovoPiano = await prisma.piano_terapeutico.create({
      data: {
        id_paziente: id_paziente,
        id_farmaco_armadietto: id_farmaco_armadietto,
        nome_utilita: nome_utilita,
        dose_singola: parseFloat(dose_singola),
        solo_al_bisogno: Boolean(solo_al_bisogno),
        terapia_attiva: Boolean(terapia_attiva),
        data_inizio: data_inizio ? new Date(data_inizio) : null,
        data_fine: data_fine ? new Date(data_fine) : null,
        note: note,
        orari: orari || []
      }
    });

    // 7. Generazione iniziale delle assunzioni
    if (
      Array.isArray(orari) &&
      !nuovoPiano.solo_al_bisogno &&
      nuovoPiano.terapia_attiva
    ) {
      const now = new Date();
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);

      let generationStart = nuovoPiano.data_inizio
        ? new Date(nuovoPiano.data_inizio)
        : startOfToday;

      if (generationStart < startOfToday) {
        generationStart = startOfToday;
      }

      let generationEnd = nuovoPiano.data_fine
        ? new Date(nuovoPiano.data_fine)
        : new Date(generationStart.getTime() + 30 * 24 * 60 * 60 * 1000);

      const intakesToCreate = [];
      let iterDate = new Date(generationStart);

      while (iterDate <= generationEnd) {
        const dateStr = iterDate.toISOString().split('T')[0];

        for (const ora of orari) {
          const scheduledTime = new Date(`${dateStr}T${ora}:00`);

          if (scheduledTime >= startOfToday) {
            intakesToCreate.push({
              id_terapia: nuovoPiano.id_terapia,
              data_programmata: scheduledTime,
              esito: null,
              orario_effettivo: null
            });
          }
        }

        iterDate.setDate(iterDate.getDate() + 1);
      }

      if (intakesToCreate.length > 0) {
        await prisma.registro_assunzioni.createMany({
          data: intakesToCreate
        });
      }
    }

    // 8. Risposta
    return NextResponse.json({
      success: true,
      message: "Piano terapeutico creato correttamente",
      data: nuovoPiano
    }, { status: 201 });

  } catch (error) {
    console.error("Errore creazione piano terapeutico:", error);

    if (error.code === 'P2003') {
      return NextResponse.json(
        { success: false, error: "Errore: Paziente o Farmaco Armadietto non validi." },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { success: false, error: "Errore interno durante il salvataggio del piano." },
      { status: 500 }
    );
  }
}


/**
 * GESTIONE GET: Recupera tutti i piani terapeutici di un paziente
 * @param {Request} request - URL con parametro ?id_paziente=...
 *
export async function GET(request) {
  // Estrae i parametri dalla query string dell'URL
  const { searchParams } = new URL(request.url);
  const idPaziente = searchParams.get('id_paziente');

  // Verifica che sia stato fornito l'ID del paziente
  if (!idPaziente) {
    return NextResponse.json({ error: 'ID paziente mancante' }, { status: 400 });
  }

  try {
    // Cerca i piani terapeutici associati a quel paziente
    const piani = await prisma.piano_terapeutico.findMany({
      where: {
        id_paziente: idPaziente,
      },
      include: {
        // Include i dettagli del farmaco presente nell'armadietto [cite: 12]
        farmaco: {
          include: {
            // Include anche le info generali del farmaco (nome, principio attivo, ecc.) [cite: 7]
            farmaco: true 
          }
        },
        // Include anche le assunzioni programmate registrate 
        assunzioni: true 
      },
    });

    // Risponde con la lista dei piani (Status 200 OK)
    return NextResponse.json({ success: true, data: piani }, { status: 200 });
  } catch (error) {
    console.error("Errore recupero piani terapeutici:", error);
    return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
  }
}
*/
// Esporta la funzione GET per gestire le richieste di lettura in modo dinamico

export async function GET(request) {
  try {
    // 1. Verifica autenticazione
    const auth = await getAuthenticatedUser();

    if (auth.error) {
      return auth.error;
    }

    // 2. Estrae i parametri dalla query string
    const { searchParams } = new URL(request.url);

    const id_terapia = searchParams.get('id_terapia');
    const id_paziente = searchParams.get('id_paziente');
    const id_farmaco_armadietto = searchParams.get('id_farmaco_armadietto');
    const nome_utilita = searchParams.get('nome_utilita');
    const solo_al_bisogno = searchParams.get('solo_al_bisogno');
    const terapia_attiva = searchParams.get('terapia_attiva');
    const data_inizio = searchParams.get('data_inizio');
    const data_fine = searchParams.get('data_fine');
    const note = searchParams.get('note');

    // 3. Il paziente deve essere sempre specificato
    if (!id_paziente) {
      return NextResponse.json(
        { success: false, error: "ID paziente mancante." },
        { status: 400 }
      );
    }

    // 4. Verifica i permessi di lettura sul paziente
    const permission = await checkPatientPermission(
      auth.userId,
      id_paziente,
      false
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: "Non hai i permessi per visualizzare le terapie di questo paziente." },
        { status: 403 }
      );
    }

    // 5. Costruisce i filtri Prisma
    // Il filtro del paziente è obbligatorio per impedire accessi globali
    const filtri = {
      id_paziente: id_paziente
    };

    if (id_terapia) {
      filtri.id_terapia = id_terapia;
    }

    if (id_farmaco_armadietto) {
      filtri.id_farmaco_armadietto = id_farmaco_armadietto;
    }

    if (nome_utilita) {
      filtri.nome_utilita = {
        contains: nome_utilita,
        mode: 'insensitive'
      };
    }

    if (solo_al_bisogno !== null) {
      filtri.solo_al_bisogno = solo_al_bisogno === 'true';
    }

    if (terapia_attiva !== null) {
      filtri.terapia_attiva = terapia_attiva === 'true';
    }

    if (data_inizio) {
      filtri.data_inizio = {
        gte: new Date(data_inizio)
      };
    }

    if (data_fine) {
      filtri.data_fine = {
        lte: new Date(data_fine)
      };
    }

    if (note) {
      filtri.note = {
        contains: note,
        mode: 'insensitive'
      };
    }

    // 6. Recupera i piani terapeutici autorizzati
    const pianiTerapeutici = await prisma.piano_terapeutico.findMany({
      where: filtri,
      include: {
        farmaco: {
          include: {
            farmaco: true
          }
        },
        assunzioni: true,
        assunzioni_passate: true
      }
    });

    // 7. Restituisce i risultati
    return NextResponse.json({
      success: true,
      count: pianiTerapeutici.length,
      data: pianiTerapeutici
    }, { status: 200 });

  } catch (error) {
    console.error("Errore durante la ricerca dinamica dei piani:", error);

    return NextResponse.json({
      success: false,
      error: "Errore interno durante il recupero dei dati."
    }, { status: 500 });
  }
}


/**
 * GESTIONE PUT: Aggiorna un piano terapeutico esistente
 * @param {Request} request
 */

export async function PUT(request) {
  try {
    // 1. Verifica autenticazione
    const auth = await getAuthenticatedUser();

    if (auth.error) {
      return auth.error;
    }

    const body = await request.json();

    const {
      id_terapia,
      id_farmaco_armadietto,
      nome_utilita,
      dose_singola,
      solo_al_bisogno,
      terapia_attiva,
      data_inizio,
      data_fine,
      note,
      orari
    } = body;

    if (!id_terapia) {
      return NextResponse.json(
        { success: false, error: "ID terapia mancante" },
        { status: 400 }
      );
    }

    // 2. Recupera la terapia esistente
    const currentTherapy = await prisma.piano_terapeutico.findUnique({
      where: { id_terapia },
      select: {
        id_paziente: true,
        orari: true,
        solo_al_bisogno: true,
        terapia_attiva: true
      }
    });

    if (!currentTherapy) {
      return NextResponse.json(
        { success: false, error: "Terapia non trovata" },
        { status: 404 }
      );
    }

    // 3. Verifica i permessi di modifica
    const permission = await checkPatientPermission(
      auth.userId,
      currentTherapy.id_paziente,
      true
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: "Non hai i permessi per modificare questa terapia." },
        { status: 403 }
      );
    }

    // 4. Se viene cambiato il farmaco, verifica che appartenga al paziente
    if (id_farmaco_armadietto !== undefined) {
      const farmaco = await prisma.farmaco_armadietto.findUnique({
        where: {
          id_farmaco_armadietto: id_farmaco_armadietto
        },
        select: {
          id_utente_proprietario: true
        }
      });

      if (!farmaco) {
        return NextResponse.json(
          { success: false, error: "Farmaco nell'armadietto non trovato." },
          { status: 404 }
        );
      }

      if (farmaco.id_utente_proprietario !== currentTherapy.id_paziente) {
        return NextResponse.json(
          { success: false, error: "Il farmaco selezionato non appartiene all'armadietto del paziente." },
          { status: 403 }
        );
      }
    }

    // 5. Costruisce i dati da aggiornare
    const dataToUpdate = {};

    if (id_farmaco_armadietto !== undefined) {
      dataToUpdate.id_farmaco_armadietto = id_farmaco_armadietto;
    }

    if (nome_utilita !== undefined) {
      dataToUpdate.nome_utilita = nome_utilita;
    }

    if (dose_singola !== undefined) {
      const dose = parseFloat(dose_singola);

      if (isNaN(dose)) {
        return NextResponse.json(
          { success: false, error: "Dose singola non valida" },
          { status: 400 }
        );
      }

      dataToUpdate.dose_singola = dose;
    }

    if (solo_al_bisogno !== undefined) {
      dataToUpdate.solo_al_bisogno = Boolean(solo_al_bisogno);
    }

    if (terapia_attiva !== undefined) {
      dataToUpdate.terapia_attiva = Boolean(terapia_attiva);
    }

    // Gestione date
    if (data_inizio !== undefined) {
      dataToUpdate.data_inizio = data_inizio ? new Date(data_inizio) : null;
    }

    if (data_fine !== undefined) {
      dataToUpdate.data_fine = data_fine ? new Date(data_fine) : null;
    }

    if (note !== undefined) {
      dataToUpdate.note = note;
    }

    if (orari !== undefined) {
      dataToUpdate.orari = orari;
    }

    // 6. Aggiorna il piano terapeutico
    const updatedTerapia = await prisma.piano_terapeutico.update({
      where: { id_terapia: id_terapia },
      data: dataToUpdate
    });

    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    // 7. LOGICA DI PAUSA (Attiva -> Disattiva)
    if (
      currentTherapy.terapia_attiva === true &&
      updatedTerapia.terapia_attiva === false
    ) {
      await prisma.registro_assunzioni.deleteMany({
        where: {
          id_terapia: id_terapia,
          data_programmata: { gte: startOfToday },
          esito: null
        }
      });
    }

    // 8. Rigenerazione e aggiornamento del calendario
    const finalOrari = orari !== undefined
      ? orari
      : currentTherapy.orari;

    const finalSoloAlBisogno = solo_al_bisogno !== undefined
      ? Boolean(solo_al_bisogno)
      : currentTherapy.solo_al_bisogno;

    if (
      Array.isArray(finalOrari) &&
      !finalSoloAlBisogno &&
      updatedTerapia.terapia_attiva
    ) {
      // Recupera le assunzioni future esistenti
      const existingPending = await prisma.registro_assunzioni.findMany({
        where: {
          id_terapia: id_terapia,
          data_programmata: { gte: startOfToday }
        },
        orderBy: { data_programmata: 'asc' }
      });

      // Calcola i nuovi orari desiderati
      let generationStart =
        updatedTerapia.data_inizio &&
        new Date(updatedTerapia.data_inizio) > startOfToday
          ? new Date(updatedTerapia.data_inizio)
          : startOfToday;

      let generationEnd = updatedTerapia.data_fine
        ? new Date(updatedTerapia.data_fine)
        : new Date(
            generationStart.getTime() + 30 * 24 * 60 * 60 * 1000
          );

      const desiredIntakes = [];
      let iterDate = new Date(generationStart);

      while (iterDate <= generationEnd) {
        const year = iterDate.getFullYear();
        const month = String(iterDate.getMonth() + 1).padStart(2, '0');
        const day = String(iterDate.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;

        for (const ora of finalOrari) {
          const scheduledTime = new Date(`${dateStr}T${ora}:00`);
          desiredIntakes.push(scheduledTime);
        }

        iterDate.setDate(iterDate.getDate() + 1);
      }

      // 9. Sincronizzazione tramite transazione
      await prisma.$transaction(async (tx) => {
        const maxIndex = Math.max(
          existingPending.length,
          desiredIntakes.length
        );

        for (let i = 0; i < maxIndex; i++) {
          if (i < existingPending.length && i < desiredIntakes.length) {
            // Aggiorna senza eliminare le assunzioni confermate
            if (existingPending[i].orario_effettivo === null) {
              await tx.registro_assunzioni.update({
                where: {
                  id_evento: existingPending[i].id_evento
                },
                data: {
                  data_programmata: desiredIntakes[i]
                }
              });
            }

          } else if (i < desiredIntakes.length) {
            // Crea i record mancanti
            await tx.registro_assunzioni.create({
              data: {
                id_terapia: id_terapia,
                data_programmata: desiredIntakes[i],
                esito: null
              }
            });

          } else if (i < existingPending.length) {
            // Elimina soltanto le assunzioni pendenti in eccesso
            if (existingPending[i].esito === null) {
              await tx.registro_assunzioni.delete({
                where: {
                  id_evento: existingPending[i].id_evento
                }
              });
            }
          }
        }
      });
    }

    return NextResponse.json({
      success: true,
      message: "Terapia aggiornata con successo (e piano ricalcolato)",
      data: updatedTerapia
    }, { status: 200 });

  } catch (error) {
    console.error("Errore aggiornamento terapia:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Errore durante l'aggiornamento"
      },
      { status: 500 }
    );
  }
}


/**
 * GESTIONE DELETE: Rimuove un piano terapeutico
 * @param {Request} request - URL con parametro ?id_terapia=...
 */

export async function DELETE(request) {
  try {
    // 1. Verifica autenticazione
    const auth = await getAuthenticatedUser();

    if (auth.error) {
      return auth.error;
    }

    // 2. Estrae l'ID della terapia
    const { searchParams } = new URL(request.url);
    const idTerapia = searchParams.get('id_terapia');

    if (!idTerapia) {
      return NextResponse.json(
        { success: false, error: "ID terapia mancante." },
        { status: 400 }
      );
    }

    // 3. Recupera la terapia e il paziente proprietario
    const terapia = await prisma.piano_terapeutico.findUnique({
      where: {
        id_terapia: idTerapia
      },
      select: {
        id_paziente: true
      }
    });

    if (!terapia) {
      return NextResponse.json(
        { success: false, error: "Terapia non trovata." },
        { status: 404 }
      );
    }

    // 4. Verifica i permessi di modifica
    const permission = await checkPatientPermission(
      auth.userId,
      terapia.id_paziente,
      true
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: "Non hai i permessi per eliminare questa terapia." },
        { status: 403 }
      );
    }

    // 5. Elimina il piano terapeutico
    await prisma.piano_terapeutico.delete({
      where: {
        id_terapia: idTerapia
      }
    });

    // 6. Conferma l'eliminazione
    return NextResponse.json({
      success: true,
      message: "Piano terapeutico eliminato con successo"
    }, { status: 200 });

  } catch (error) {
    console.error("Errore eliminazione piano:", error);

    if (error.code === 'P2025') {
      return NextResponse.json(
        { success: false, error: "Terapia non trovata." },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Impossibile eliminare il piano terapeutico."
      },
      { status: 500 }
    );
  }
}

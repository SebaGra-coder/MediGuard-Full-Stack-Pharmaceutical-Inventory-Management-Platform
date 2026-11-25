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

async function checkCabinetPermission(userId, patientId, requireWrite = false) {
  if (userId === patientId) {
    return { authorized: true, permission: 'OWNER' };
  }

  const relazione = await prisma.relazione.findFirst({
    where: {
      id_caregiver: userId,
      id_assistito: patientId
    },
    select: {
      permessi_armadietto: true
    }
  });

  if (!relazione || relazione.permessi_armadietto === 'NIENTE') {
    return { authorized: false };
  }

  if (requireWrite && relazione.permessi_armadietto !== 'ADMIN') {
    return { authorized: false };
  }

  return {
    authorized: true,
    permission: relazione.permessi_armadietto
  };
}

/**
 * POST → Registra una nuova allergia per un utente
 */
export async function POST(request) {
  try {
    const auth = await getAuthenticatedUser();
    if (auth.error) return auth.error;
    // Legge il corpo della richiesta JSON
    const body = await request.json();
    // Estrae i campi necessari dal body
    const { id_utente, id_allergene, gravita_reazione } = body;

    // Verifica la presenza dei campi obbligatori
    if (!id_utente || !id_allergene || gravita_reazione === undefined) {
      // Ritorna errore 400 se mancano dati
      return NextResponse.json({ success: false, message: "Dati mancanti" }, { status: 400 });
    }

    const permission = await checkCabinetPermission(
      auth.userId,
      id_utente,
      true
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: 'Non autorizzato a modificare queste allergie.' },
        { status: 403 }
      );
    }

    // Crea il record nel database
    const nuovaAllergia = await prisma.allergia_utente.create({
      data: {
        id_utente,
        id_allergene,
        gravita_reazione: parseInt(gravita_reazione) // Assicura che sia un intero
      }
    });

    // Ritorna il record creato con successo
    return NextResponse.json({ success: true, data: nuovaAllergia }, { status: 201 });
  } catch (error) {
    // Gestione errore e log in console
    console.error("Errore POST:", error);
    // Ritorna errore server
    return NextResponse.json({ success: false, error: "Errore creazione" }, { status: 500 });
  }
}

/**
 * GET → Recupera le allergie di un utente
 */
export async function GET(request) {
  try {

    const auth = await getAuthenticatedUser();
    if (auth.error) return auth.error;
    // Estrae i parametri dalla URL
    const { searchParams } = new URL(request.url);
    // Recupera l'ID utente dai parametri
    const id_utente = searchParams.get("id_utente");

    // Verifica se l'ID utente è presente
    if (!id_utente) {
      return NextResponse.json({ success: false, message: "ID utente mancante" }, { status: 400 });
    }

    const permission = await checkCabinetPermission(
      auth.userId,
      id_utente
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: 'Non autorizzato a visualizzare queste allergie.' },
        { status: 403 }
      );
    }

    // Cerca tutte le allergie associate a quell'utente
    const allergie = await prisma.allergia_utente.findMany({
      where: { id_utente: id_utente },
      // Include il nome della sostanza dalla tabella Allergeni
      include: { allergene: { select: { sostanza_allergene: true } } }
    });

    // Ritorna la lista delle allergie
    return NextResponse.json({ success: true, data: allergie });
  } catch (error) {
    // Log e ritorno errore
    console.error("Errore GET:", error);
    return NextResponse.json({ success: false, error: "Errore recupero" }, { status: 500 });
  }
}

/**
 * PATCH → Modifica la gravità di un'allergia esistente
 */
export async function PATCH(request) {
  try {
    const auth = await getAuthenticatedUser();
    if (auth.error) return auth.error;
    // Legge il corpo della richiesta
    const body = await request.json();
    // Estrae l'ID univoco dell'allergia e la nuova gravità
    const { id_allergia, gravita_reazione } = body;

    // Verifica che l'ID sia fornito
    if (!id_allergia || gravita_reazione === undefined) {
      return NextResponse.json({ success: false, message: "ID o Gravità mancanti" }, { status: 400 });
    }

    const allergiaEsistente = await prisma.allergia_utente.findUnique({
      where: { id_allergia },
      select: { id_utente: true }
    });

    if (!allergiaEsistente) {
      return NextResponse.json(
        { success: false, error: 'Allergia non trovata.' },
        { status: 404 }
      );
    }

    const permission = await checkCabinetPermission(
      auth.userId,
      allergiaEsistente.id_utente,
      true
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: 'Non autorizzato a modificare questa allergia.' },
        { status: 403 }
      );
    }

    // Aggiorna il record specifico tramite il suo ID (UUID)
    const aggiornata = await prisma.allergia_utente.update({
      where: { id_allergia: id_allergia },
      data: { gravita_reazione: parseInt(gravita_reazione) }
    });

    // Ritorna il record aggiornato
    return NextResponse.json({ success: true, data: aggiornata });
  } catch (error) {
    // Log e gestione errore (es. se l'ID non esiste)
    console.error("Errore PATCH:", error);
    return NextResponse.json({ success: false, error: "Errore aggiornamento" }, { status: 500 });
  }
}

/**
 * DELETE → Rimuove un'allergia dal profilo utente
 */
export async function DELETE(request) {
  try {
    const auth = await getAuthenticatedUser();
    if (auth.error) return auth.error;
    // Estrae i parametri dalla URL
    const { searchParams } = new URL(request.url);
    // Recupera l'ID dell'allergia da eliminare
    const id_allergia = searchParams.get("id_allergia");

    // Verifica se l'ID è presente
    if (!id_allergia) {
      return NextResponse.json({ success: false, message: "ID allergia mancante" }, { status: 400 });
    }

    const allergiaEsistente = await prisma.allergia_utente.findUnique({
      where: { id_allergia },
      select: { id_utente: true }
    });

    if (!allergiaEsistente) {
      return NextResponse.json(
        { success: false, error: 'Allergia non trovata.' },
        { status: 404 }
      );
    }

    const permission = await checkCabinetPermission(
      auth.userId,
      allergiaEsistente.id_utente,
      true
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: 'Non autorizzato a eliminare questa allergia.' },
        { status: 403 }
      );
    }

    // Elimina il record dal database
    await prisma.allergia_utente.delete({
      where: { id_allergia: id_allergia }
    });

    // Ritorna messaggio di successo
    return NextResponse.json({ success: true, message: "Allergia eliminata" });
  } catch (error) {
    // Log e ritorno errore
    console.error("Errore DELETE:", error);
    return NextResponse.json({ success: false, error: "Errore eliminazione" }, { status: 500 });
  }
}
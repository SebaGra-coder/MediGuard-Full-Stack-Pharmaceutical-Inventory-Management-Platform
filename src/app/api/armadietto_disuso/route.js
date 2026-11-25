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

export async function GET(request) {
  try {
    const auth = await getAuthenticatedUser();
    if (auth.error) return auth.error;
    // Estrae i parametri dalla URL
    const { searchParams } = new URL(request.url);
    const idUtente = searchParams.get('id_utente');

    // Validazione ID utente
    if (!idUtente) {
      return NextResponse.json({ error: 'ID utente mancante' }, { status: 400 });
    }

    const permission = await checkCabinetPermission(
      auth.userId,
      idUtente
    );

    if (!permission.authorized) {
      return NextResponse.json(
        { success: false, error: 'Non autorizzato a visualizzare questo armadietto.' },
        { status: 403 }
      );
    }

    // Ricerca nel database basata sul modello Farmaco_armadietto_disuso
    const dati = await prisma.farmaco_armadietto_disuso.findMany({
      where: {
        id_utente_proprietario: idUtente
      }
    });

    // Risposta di successo
    return NextResponse.json({ data: dati }, { status: 200 });

  } catch (error) {
    console.error("Errore API:", error);
    return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
  }
}
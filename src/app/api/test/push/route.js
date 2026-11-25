
import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import webpush from 'web-push';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // 1. Recupera il cookie di sessione
    const cookieStore = await cookies();
    const token = cookieStore.get('session_token');

    if (!token) {
      return NextResponse.json(
        { error: 'Autenticazione richiesta.' },
        { status: 401 }
      );
    }

    // 2. Verifica il JWT
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      console.error('JWT_SECRET non configurata.');
      return NextResponse.json(
        { error: 'Errore di configurazione del server.' },
        { status: 500 }
      );
    }

    let decoded;

    try {
      decoded = jwt.verify(token.value, secret);
    } catch {
      return NextResponse.json(
        { error: 'Sessione non valida o scaduta.' },
        { status: 401 }
      );
    }

    if (!decoded || typeof decoded === 'string' || !decoded.id) {
      return NextResponse.json(
        { error: 'Sessione non valida.' },
        { status: 401 }
      );
    }

    // 3. Verifica che l'utente esista ancora
    const utente = await prisma.utente.findUnique({
      where: { id_utente: decoded.id },
      select: { id_utente: true }
    });

    if (!utente) {
      return NextResponse.json(
        { error: 'Utente non trovato.' },
        { status: 401 }
      );
    }

    // 4. Verifica la configurazione Web Push
    if (
      !process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
      !process.env.VAPID_PRIVATE_KEY
    ) {
      return NextResponse.json(
        { error: 'Configurazione Web Push non disponibile.' },
        { status: 500 }
      );
    }

    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:test@example.com',
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    // 5. Cerca esclusivamente le sottoscrizioni dell'utente autenticato
    const subscriptions = await prisma.sottoscrizione_web_push.findMany({
      where: { id_utente: utente.id_utente }
    });

    if (subscriptions.length === 0) {
      return NextResponse.json({
        message: 'Nessuna sottoscrizione attiva trovata per questo utente.'
      });
    }

    // 6. Prepara il messaggio
    const payload = JSON.stringify({
      title: '🧪 Test Notifica',
      body: 'Se leggi questo messaggio, il sistema funziona perfettamente!',
      url: '/'
    });

    // 7. Invia la notifica ai dispositivi dell'utente
    const results = await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          const pushConfig = {
            endpoint: sub.endpoint_browser,
            keys: sub.chiavi_cifratura_json
          };

          await webpush.sendNotification(pushConfig, payload);

          return {
            device: sub.user_agent,
            status: 'Inviata'
          };
        } catch (err) {
          console.error('Errore invio Web Push:', err);

          return {
            device: sub.user_agent,
            status: 'Fallita'
          };
        }
      })
    );

    return NextResponse.json({
      success: true,
      risultati: results
    });

  } catch (error) {
    console.error('Errore endpoint test Web Push:', error);

    return NextResponse.json(
      { error: 'Errore interno del server.' },
      { status: 500 }
    );
  }
}

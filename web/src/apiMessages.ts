// Autor: Matheus C. Pestana — MACAPE Pesquisas e Consultoria em Tecnologia Ltda
/**
 * Mensagens fixas que a API devolve em português. Ficam marcadas aqui para o i18n:check exigir a
 * tradução; o painel as traduz com tApi() quando elas chegam idênticas. Mensagens com valores
 * variáveis (frequências, erros dos decodificadores) aparecem como vieram.
 */
import { markApi } from './i18n'

export const API_MESSAGES = [
  markApi('voz/SSTV em 145.800 FM (eventos) e APRS em 145.825'),
  markApi('RTL-SDR V4 via USB (um modo por vez)'),
  markApi('defina a localização da estação em Config antes de procurar sondas'),
]

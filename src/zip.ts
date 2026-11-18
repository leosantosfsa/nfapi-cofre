// Arquivo ZIP montado enquanto é enviado: cada entrada é lida, comprimida e
// escrita na resposta, sem guardar o arquivo inteiro na memória.

export interface EntradaZip {
	/** Caminho dentro do ZIP, com "/" como separador. */
	nome: string;
	/** Conteúdo; null quando o arquivo não existe mais (a entrada é pulada). */
	dados: () => Promise<Uint8Array | null>;
}

const TABELA_CRC = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[i] = c >>> 0;
	}
	return t;
})();

export function crc32(dados: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < dados.length; i++) c = (TABELA_CRC[(c ^ (dados[i] as number)) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

async function comprimir(dados: Uint8Array): Promise<Uint8Array> {
	// A cópia garante um buffer próprio (os tipos do Workers e do DOM divergem aqui).
	const fluxo = new Blob([new Uint8Array(dados)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(fluxo).arrayBuffer());
}

/** Data e hora no formato do ZIP (resolução de 2 segundos). */
function dataDos(d: Date): { hora: number; dia: number } {
	return {
		hora: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
		dia: ((Math.max(d.getUTCFullYear(), 1980) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
	};
}

interface Registro {
	nome: Uint8Array;
	crc: number;
	comprimido: number;
	original: number;
	metodo: number;
	posicao: number;
}

const BANDEIRA_UTF8 = 0x0800;

function cabecalho(assinatura: number, r: Registro, quando: { hora: number; dia: number }, central: boolean): Uint8Array {
	const b = new Uint8Array((central ? 46 : 30) + r.nome.length);
	const v = new DataView(b.buffer);
	let p = 0;
	const u16 = (n: number) => { v.setUint16(p, n, true); p += 2; };
	const u32 = (n: number) => { v.setUint32(p, n >>> 0, true); p += 4; };
	u32(assinatura);
	if (central) u16(20); // versão que criou
	u16(20); // versão necessária
	u16(BANDEIRA_UTF8);
	u16(r.metodo);
	u16(quando.hora);
	u16(quando.dia);
	u32(r.crc);
	u32(r.comprimido);
	u32(r.original);
	u16(r.nome.length);
	u16(0); // campo extra
	if (central) {
		u16(0); // comentário
		u16(0); // disco
		u16(0); // atributos internos
		u32(0); // atributos externos
		u32(r.posicao);
	}
	b.set(r.nome, p);
	return b;
}

/**
 * ZIP das entradas, na ordem dada. `agora` é a data gravada nos arquivos.
 * Limites do formato simples: até 65 535 entradas e 4 GB no total.
 */
export function zipStream(entradas: EntradaZip[], agora = new Date()): ReadableStream<Uint8Array> {
	const quando = dataDos(agora);
	const registros: Registro[] = [];
	const usados = new Set<string>();
	let proxima = 0;
	let posicao = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controle) {
			while (proxima < entradas.length) {
				const entrada = entradas[proxima++] as EntradaZip;
				const dados = await entrada.dados();
				if (!dados) continue;
				// Dois arquivos com o mesmo caminho: o segundo ganha um sufixo.
				let nome = entrada.nome;
				for (let i = 2; usados.has(nome); i++) nome = entrada.nome.replace(/(\.[^./]+)?$/, `-${i}$1`);
				usados.add(nome);
				const comprimido = await comprimir(dados);
				const usar = comprimido.length < dados.length;
				const corpo = usar ? comprimido : dados;
				const registro: Registro = { nome: new TextEncoder().encode(nome), crc: crc32(dados), comprimido: corpo.length, original: dados.length, metodo: usar ? 8 : 0, posicao };
				registros.push(registro);
				const local = cabecalho(0x04034b50, registro, quando, false);
				controle.enqueue(local);
				controle.enqueue(corpo);
				posicao += local.length + corpo.length;
				return;
			}
			const inicio = posicao;
			for (const r of registros) {
				const central = cabecalho(0x02014b50, r, quando, true);
				controle.enqueue(central);
				posicao += central.length;
			}
			const fim = new Uint8Array(22);
			const v = new DataView(fim.buffer);
			v.setUint32(0, 0x06054b50, true);
			v.setUint16(8, registros.length, true);
			v.setUint16(10, registros.length, true);
			v.setUint32(12, posicao - inicio, true);
			v.setUint32(16, inicio, true);
			controle.enqueue(fim);
			controle.close();
		},
	});
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Ambiente, nfseAmbiente } from "../src/fiscal/dados";
import { XmlDocument, XsdValidator } from "libxml2-wasm";
import { xmlRegisterFsInputProviders } from "libxml2-wasm/lib/nodejs.mjs";
import { afterAll, describe, expect, it } from "vitest";
import { signXml } from "../src/signer";
import { CNPJ_TESTE, certificadoTeste } from "../test/helpers";
import { NfseInput, idDps, montarDps } from "../src/nfse";

xmlRegisterFsInputProviders();

const SCHEMAS = path.join(import.meta.dirname, "../schemas/nfse");

/**
 * O XSD oficial de produção (pacote 20260209) define o padrão da série como
 * `^0{0,4}\d{1,5}$`. Em expressões regulares de XSD, `^` e `$` são caracteres
 * literais, então um validador estrito recusa qualquer série. O validador da
 * SEFIN (.NET) trata como âncoras, e o pacote de produção restrita já traz o
 * padrão corrigido. Para validar o resto do documento, usamos uma cópia
 * temporária com só esse padrão ajustado; o arquivo oficial fica intacto.
 */
const pastasCorrigidas = new Map<string, string>();
function pastaDeSchemas(nome: string): string {
	let pasta = pastasCorrigidas.get(nome);
	if (!pasta) {
		pasta = fs.mkdtempSync(path.join(os.tmpdir(), `nfapi-xsd-${nome}-`));
		for (const arquivo of fs.readdirSync(path.join(SCHEMAS, nome))) {
			const conteudo = fs.readFileSync(path.join(SCHEMAS, nome, arquivo), "utf8");
			fs.writeFileSync(
				path.join(pasta, arquivo),
				conteudo.replace('value="^0{0,4}\\d{1,5}$"', 'value="0{0,4}\\d{1,5}"'),
			);
		}
		pastasCorrigidas.set(nome, pasta);
	}
	return pasta;
}

afterAll(() => {
	for (const pasta of pastasCorrigidas.values()) fs.rmSync(pasta, { recursive: true, force: true });
});

/** Valida contra o XSD oficial do ambiente; devolve a lista de erros (vazia = válido). */
function validar(xml: string, ambiente: Ambiente): string[] {
	const arquivo = path.join(pastaDeSchemas(nfseAmbiente(ambiente).schemas), "DPS_v1.01.xsd");
	const xsd = XmlDocument.fromBuffer(fs.readFileSync(arquivo), { url: pathToFileURL(arquivo).href });
	const validador = XsdValidator.fromDoc(xsd);
	const doc = XmlDocument.fromString(xml);
	try {
		validador.validate(doc);
		return [];
	} catch (err) {
		const detalhes = (err as { details?: { message: string }[] }).details;
		return detalhes?.map((d) => d.message.trim()) ?? [String(err)];
	} finally {
		doc.dispose();
		validador.dispose();
		xsd.dispose();
	}
}

const minima = NfseInput.parse({
	prestador: {
		codigoMunicipio: "3550308",
		regimeTributario: { simplesNacional: "me_epp", apuracaoSimples: 1 },
	},
	servico: {
		codigoMunicipioPrestacao: "3550308",
		codigoTributacaoNacional: "010701",
		descricao: "Suporte técnico em informática",
	},
	valores: { servico: 1500 },
	tributacao: { issqn: {} },
});

const completa = NfseInput.parse({
	serie: "7",
	dataEmissao: "2026-11-16T10:30:00.123-03:00",
	dataCompetencia: "2026-11-15",
	prestador: {
		codigoMunicipio: "3550308",
		inscricaoMunicipal: "12345678",
		telefone: "1133334444",
		email: "fiscal@empresa-teste.com.br",
		regimeTributario: { simplesNacional: "nao_optante", regimeEspecial: 0 },
	},
	tomador: {
		cnpj: "99888777000166",
		nome: "Cliente & Filhos <Ltda>",
		inscricaoMunicipal: "998877",
		endereco: {
			codigoMunicipio: "3304557",
			cep: "20040002",
			logradouro: "Av. Rio Branco",
			numero: "1",
			complemento: "Sala 101",
			bairro: "Centro",
		},
		telefone: "2122223333",
		email: "compras@cliente.com.br",
	},
	servico: {
		codigoMunicipioPrestacao: "3304557",
		codigoTributacaoNacional: "010701",
		codigoTributacaoMunicipal: "001",
		descricao: "Desenvolvimento de sistema\nsob encomenda",
		codigoNbs: "115022000",
		codigoInterno: "DEV01",
		informacoesComplementares: "Pedido 4500012345",
	},
	valores: { servico: 12345.6, descontoIncondicionado: 100, descontoCondicionado: 0.5 },
	tributacao: {
		issqn: { tipo: "tributavel", retencao: "retido_tomador", aliquota: 2.5 },
		federal: {
			pisCofins: {
				cst: "01",
				baseCalculo: 12245.6,
				aliquotaPis: 0.65,
				aliquotaCofins: 3,
				valorPis: 79.6,
				valorCofins: 367.37,
				retencao: 1,
			},
			retencaoCp: 0,
			retencaoIrrf: 183.68,
			retencaoCsll: 122.46,
		},
		totalTributos: { tipo: "valores", federal: 1650.12, estadual: 0, municipal: 306.14 },
	},
});

const contexto = (ambiente: Ambiente) => ({
	ambiente,
	leiaute: nfseAmbiente(ambiente).leiaute,
	emitente: { tipo: "cnpj" as const, numero: CNPJ_TESTE },
	numero: 42,
	versaoAplicativo: "NFapi-0.1.0",
	agora: new Date("2026-11-16T15:00:00Z"),
});

describe("montarDps", () => {
	for (const ambiente of ["producao", "homologacao"] as const) {
		it(`gera DPS mínima e completa válidas no XSD oficial de ${ambiente}`, () => {
			expect(validar(montarDps(minima, contexto(ambiente)).xml, ambiente)).toEqual([]);
			expect(validar(montarDps(completa, contexto(ambiente)).xml, ambiente)).toEqual([]);
		});
	}

	it("os dois leiautes são de fato diferentes: um não passa no schema do outro", () => {
		const deProducao = montarDps(completa, contexto("producao")).xml;
		const deHomologacao = montarDps(completa, contexto("homologacao")).xml;
		expect(validar(deProducao, "homologacao")).not.toEqual([]);
		expect(validar(deHomologacao, "producao")).not.toEqual([]);
		expect(deHomologacao).toContain("<finNFSe>0</finNFSe>");
		expect(deProducao).not.toContain("finNFSe");
	});

	it("monta o Id, o ambiente e as datas conforme as regras da DPS", () => {
		const hom = montarDps(minima, contexto("homologacao"));
		expect(hom.id).toBe(`DPS35503082${CNPJ_TESTE}00001000000000000042`);
		expect(hom.id).toHaveLength(45);
		expect(hom.xml).toContain(`<infDPS Id="${hom.id}">`);
		expect(hom.xml).toContain("<tpAmb>2</tpAmb>");
		// Sem dataEmissao, usa o horário de Brasília do instante atual.
		expect(hom.xml).toContain("<dhEmi>2026-11-16T12:00:00-03:00</dhEmi>");
		expect(hom.xml).toContain("<dCompet>2026-11-16</dCompet>");

		const prod = montarDps(completa, contexto("producao"));
		expect(prod.xml).toContain("<tpAmb>1</tpAmb>");
		expect(prod.xml).toContain("<dhEmi>2026-11-16T10:30:00-03:00</dhEmi>");
		expect(prod.xml).toContain("<vServ>12345.60</vServ>");
		expect(prod.xml).toContain("<pAliq>2.50</pAliq>");

		// CPF é completado com zeros à esquerda e usa o tipo 1.
		expect(idDps("3550308", { tipo: "cpf", numero: "12345678909" }, "1", 1)).toBe(
			"DPS355030810001234567890900001000000000000001",
		);
	});

	it("escapa caracteres especiais e não deixa espaços entre as tags", () => {
		const { xml } = montarDps(completa, contexto("producao"));
		expect(xml).toContain("<xNome>Cliente &amp; Filhos &lt;Ltda&gt;</xNome>");
		expect(xml).not.toMatch(/>\s+</);
	});

	it("a DPS assinada pelo cofre continua válida no XSD", () => {
		const cert = certificadoTeste();
		for (const ambiente of ["producao", "homologacao"] as const) {
			const assinada = signXml({
				xml: montarDps(completa, contexto(ambiente)).xml,
				tag: "infDPS",
				profile: "rsa-sha256",
				privateKeyPem: cert.privateKeyPem,
				certificatePem: cert.certificatePem,
				holder: cert.holder,
				allowProduction: true,
			});
			expect(assinada.environment).toBe(ambiente);
			expect(assinada.xml).toMatch(/<\/infDPS><Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">/);
			expect(validar(assinada.xml, ambiente)).toEqual([]);
		}
	});
});

describe("NfseInput", () => {
	it("recusa valores fora do formato antes de montar o XML", () => {
		const base = {
			prestador: { codigoMunicipio: "3550308", regimeTributario: { simplesNacional: "mei" } },
			servico: { codigoMunicipioPrestacao: "3550308", codigoTributacaoNacional: "010701", descricao: "x" },
			valores: { servico: 10 },
			tributacao: { issqn: {} },
		};
		expect(NfseInput.safeParse(base).success).toBe(true);
		expect(NfseInput.safeParse({ ...base, valores: { servico: 10.001 } }).success).toBe(false);
		expect(NfseInput.safeParse({ ...base, valores: { servico: -1 } }).success).toBe(false);
		expect(
			NfseInput.safeParse({ ...base, servico: { ...base.servico, codigoTributacaoNacional: "1.07" } }).success,
		).toBe(false);
		const doisDocs = { ...base, tomador: { cnpj: "99888777000166", cpf: "12345678909", nome: "X" } };
		expect(NfseInput.safeParse(doisDocs).success).toBe(false);
		expect(NfseInput.safeParse({ ...base, tomador: { nome: "Sem documento" } }).success).toBe(false);
	});
});

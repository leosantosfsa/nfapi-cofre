import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Ambiente, nfseAmbiente } from "../src/fiscal/dados";
import { XmlDocument, XsdValidator } from "libxml2-wasm";
import { xmlRegisterFsInputProviders } from "libxml2-wasm/lib/nodejs.mjs";
import { describe, expect, it } from "vitest";
import { signXml } from "../src/signer";
import { CNPJ_TESTE, certificadoTeste } from "../test/helpers";
import { CancelamentoInput, gzipBase64, lerRespostaEvento, montarPedidoCancelamento } from "../src/nfse";

xmlRegisterFsInputProviders();
const SCHEMAS = path.join(import.meta.dirname, "../schemas/nfse");
// Chave fictícia, montada com o CNPJ de teste.
const CHAVE = "35503082112223330001810000000000042261112345678907";

function validar(xml: string, ambiente: Ambiente): string[] {
	const arquivo = path.join(SCHEMAS, nfseAmbiente(ambiente).schemas, "pedRegEvento_v1.01.xsd");
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

const pedido = (ambiente: Ambiente) =>
	montarPedidoCancelamento(
		{ motivo: "erro_emissao", justificativa: "Nota de teste emitida por engano & cancelada" },
		{
			ambiente,
			autor: { tipo: "cnpj", numero: CNPJ_TESTE },
			chaveAcesso: CHAVE,
			versaoAplicativo: "NFapi-0.1.0",
			agora: new Date("2026-11-16T15:00:00Z"),
		},
	);

describe("pedido de cancelamento da NFS-e", () => {
	for (const ambiente of ["producao", "homologacao"] as const) {
		it(`é válido no XSD oficial de ${ambiente}, antes e depois de assinado pelo cofre`, () => {
			const { xml } = pedido(ambiente);
			expect(validar(xml, ambiente)).toEqual([]);

			const cert = certificadoTeste();
			const assinado = signXml({
				xml,
				tag: "infPedReg",
				profile: "rsa-sha256",
				privateKeyPem: cert.privateKeyPem,
				certificatePem: cert.certificatePem,
				holder: cert.holder,
				allowProduction: true,
			});
			expect(assinado.environment).toBe(ambiente);
			expect(validar(assinado.xml, ambiente)).toEqual([]);
		});
	}

	it("monta o Id com a chave e o código do evento, e escapa a justificativa", () => {
		const { xml, id } = pedido("producao");
		expect(id).toBe(`PRE${CHAVE}101101`);
		expect(id).toHaveLength(59);
		expect(xml).toContain(`<infPedReg Id="${id}"><tpAmb>1</tpAmb>`);
		expect(xml).toContain("<dhEvento>2026-11-16T12:00:00-03:00</dhEvento>");
		expect(xml).toContain(`<CNPJAutor>${CNPJ_TESTE}</CNPJAutor><chNFSe>${CHAVE}</chNFSe>`);
		expect(xml).toContain("<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo>");
		expect(xml).toContain("por engano &amp; cancelada</xMotivo>");
	});

	it("exige motivo conhecido e justificativa de 15 a 255 caracteres", () => {
		expect(CancelamentoInput.safeParse({ motivo: "outros", justificativa: "curta" }).success).toBe(false);
		expect(CancelamentoInput.safeParse({ motivo: "arrependimento", justificativa: "x".repeat(20) }).success).toBe(false);
		expect(CancelamentoInput.safeParse({ motivo: "servico_nao_prestado", justificativa: "x".repeat(256) }).success).toBe(false);
		expect(CancelamentoInput.safeParse({ motivo: "outros", justificativa: "Cancelamento a pedido do cliente" }).success).toBe(true);
	});

	it("lê a resposta do registro: evento registrado, rejeição e resposta inconclusiva", async () => {
		const evento = "<evento><infEvento Id=\"EVT1\"/></evento>";
		const ok = await lerRespostaEvento(201, JSON.stringify({ eventoXmlGZipB64: await gzipBase64(evento) }));
		expect(ok).toEqual({ tipo: "registrado", xml: evento });

		const recusa = await lerRespostaEvento(400, JSON.stringify({ erro: [{ codigo: "E0840", descricao: "Evento já registrado" }] }));
		expect(recusa).toMatchObject({ tipo: "rejeitada", rejeicoes: [{ codigo: "E0840" }] });

		expect((await lerRespostaEvento(503, "indisponível")).tipo).toBe("indefinida");
		expect((await lerRespostaEvento(201, "{}")).tipo).toBe("indefinida");
	});
});

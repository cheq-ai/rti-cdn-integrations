import { describe, it, expect } from 'vitest';
import { RTIHelperService } from './rti-helper.service';

const service = new RTIHelperService({} as any);

describe('RTIHelperService.parseCookies', () => {

    // --- Empty / missing input ---

    it('returns all undefined for empty string', () => {
        const result = service.parseCookies('');
        expect(result.duidCookie).toBeUndefined();
        expect(result.pvidCookie).toBeUndefined();
        expect(result.sCookie).toBeUndefined();
    });

    it('returns all undefined when no CHEQ cookies are present', () => {
        const result = service.parseCookies('session=abc123; theme=dark; other=ignored');
        expect(result.duidCookie).toBeUndefined();
        expect(result.pvidCookie).toBeUndefined();
        expect(result.sCookie).toBeUndefined();
    });

    // --- Individual cookie extraction ---

    it('extracts only _cq_duid when present', () => {
        const result = service.parseCookies('_cq_duid=4.16a154e6ae45bc91bf9a49b365beb989');
        expect(result.duidCookie).toBe('4.16a154e6ae45bc91bf9a49b365beb989');
        expect(result.pvidCookie).toBeUndefined();
        expect(result.sCookie).toBeUndefined();
    });

    it('extracts only _cq_pvid when present', () => {
        const result = service.parseCookies('_cq_pvid=4.247bcdf08360a9de9dee2196c1a36631');
        expect(result.duidCookie).toBeUndefined();
        expect(result.pvidCookie).toBe('4.247bcdf08360a9de9dee2196c1a36631');
        expect(result.sCookie).toBeUndefined();
    });

    it('extracts only _cq_s when present', () => {
        const result = service.parseCookies('_cq_s=simple-value');
        expect(result.duidCookie).toBeUndefined();
        expect(result.pvidCookie).toBeUndefined();
        expect(result.sCookie).toBe('simple-value');
    });

    // --- All three together ---

    it('extracts all three cookies when all present', () => {
        const result = service.parseCookies('_cq_duid=4.16a154e6ae45bc91bf9a49b365beb989; _cq_pvid=4.247bcdf08360a9de9dee2196c1a36631; _cq_s=simple-value');
        expect(result.duidCookie).toBe('4.16a154e6ae45bc91bf9a49b365beb989');
        expect(result.pvidCookie).toBe('4.247bcdf08360a9de9dee2196c1a36631');
        expect(result.sCookie).toBe('simple-value');
    });

    // --- Noise cookies around CHEQ cookies ---

    it('ignores unrelated cookies when extracting all three', () => {
        const b64 = 'Ll7dvXH3YTlLM7nA:0pSlsKE44ASXSpI4yGmRpP+Rdwm3eR4RvkFIY60Jz1E/mWlZSilQ7METgbQuPTv1nfazHTyvz6qWSGx6GEeMYj9gTIIS38l/v7sO/xjLE7QVlUGtCQQS+5thTzsVRLejEV/3lrOQspnfY9sp5D5lGaEYa+k3yxdOjLp1kEVk/m7RQh2Nb1+Vbn+NaSRQ6CGIgJ/5BnEkYA==:uAmNscAbgD/vSVVN3OE4Ow==';
        const cookie = `session=abc123; _cq_duid=d-uuid-xyz; theme=dark; _cq_pvid=pv-ulid-abc; _cq_s=${b64}; other=ignored`;
        const result = service.parseCookies(cookie);
        expect(result.duidCookie).toBe('d-uuid-xyz');
        expect(result.pvidCookie).toBe('pv-ulid-abc');
        expect(result.sCookie).toBe(b64);
    });

    // --- Base64 padding in _cq_s ---

    it('preserves base64 = padding characters in _cq_s', () => {
        const b64 = 'c0hdForhWGaRercD:kc/eGTcRHnanstWrlbv6fnBWg/kICuKe+hRiK6x9lCwkrSdhpKIohwyd7/JHH3aA81pNurK0WfbwmJfGwL61DFBsgrr3wYpT8muwEt/xhOrFe3Ejee4W86fnE/fe0l1b1+ld6JwCiA7tueF0weoJStmpVEKW8PTz+JTkOf9jMfEE/HYNMrG22F+h7w68Td+JeCURnRPp48TbVAtusLvNuwWwWSyuI/7OfV6akdMrey+Mr2b8i8+w9Cm58M+Ttq1ydQPcQbHGOPfI5InnCSqHbGT0mUMxdodBMXFmvQgTN07lge/+zjGSH2+s+a0b60QlNOa6rw==:Ki6FWCQbEiMijlXZ/6/BNQ==';
        const result = service.parseCookies(`_cq_s=${b64}`);
        expect(result.sCookie).toBe(b64);
    });

    it('preserves base64 = padding in _cq_s when mixed with other cookies', () => {
        const b64 = 'Qxr2YUViJVxjN/Lj:/ZN3E52EztskUvgEC4J+kf4iZ5bM0INszRKC8IWXUzH2Qm2K4ByU/oBBroRABQOUoSPEqH8kulCnl7oy3AcaXS/RlwFPROQ7YzzGVwxWos6lTFMMbRgDlTkC7uwA50UwqlkWjrmEmmimz5gEQQc0HaDHw7TDo7INomrDm2vnJFMyKieBu0sD8k6cM1f9ORUphNF+Lezms73AyIgC7YV1RK3T3T8kpIkePoTrjzCFtM4rWQ9IHmk4Qcb39TUK+TOIyr38Sb/oODE25SLwyCgQY1KDVjyb452nlo1+E55bxXMmkocgnqDqyOOjTqtoYqROmYRhQcrjVr13gX4NPj/1OOp3pwSUsR0E1ji0VfArMzRZ6H4TfL610HnxF87NNVlyIwg+2lXu5md4PaC2pCck7q7q3fEcB+QkeA+fdlhuiI6s++MQ4+2FNyqZiIoLz/2vrLdVDgbVchS9kb3vJljm4gAswQbZHT50zrQKpXJZtduxYsWIbNOyrF2VGrzTDwyBpTumYaA+jcisuSax/Gntjtl5thWkFaq6iRYdIEFLDDK7SyMlylFGEHg8O4/Sh8ha0j3CX3Q=:GwUKuinki4bX6547azx1Rw==';
        const result = service.parseCookies(`session=abc; _cq_duid=d-uuid; _cq_pvid=pv-ulid; _cq_s=${b64}`);
        expect(result.duidCookie).toBe('d-uuid');
        expect(result.pvidCookie).toBe('pv-ulid');
        expect(result.sCookie).toBe(b64);
    });

    // --- Prefix overlap: _cq_se must not match _cq_s ---

    it('does not extract _cq_se as _cq_s', () => {
        const result = service.parseCookies('_cq_se=token|rayid; _cq_s=real-value');
        expect(result.sCookie).toBe('real-value');
    });

    it('returns undefined for _cq_s when only _cq_se is present', () => {
        const result = service.parseCookies('_cq_se=token|rayid');
        expect(result.sCookie).toBeUndefined();
    });

    // --- Special characters in values ---

    it('preserves / + : characters in _cq_s value', () => {
        const value = 'abc/def+ghi:jkl';
        const result = service.parseCookies(`_cq_s=${value}`);
        expect(result.sCookie).toBe(value);
    });

    // --- Whitespace handling ---

    it('trims whitespace around cookie entries including trailing spaces in values', () => {
        // .trim() strips the whole "name=value" token, so trailing spaces inside the value are also removed
        const result = service.parseCookies('  _cq_duid=d-abc  ;  _cq_pvid=pv-xyz  ;  _cq_s=s-val  ');
        expect(result.duidCookie).toBe('d-abc');
        expect(result.pvidCookie).toBe('pv-xyz');
        expect(result.sCookie).toBe('s-val');
    });

    // --- Empty cookie value ---

    it('returns undefined when _cq_s has no value', () => {
        const result = service.parseCookies('_cq_s=');
        expect(result.sCookie).toBeUndefined();
    });

    it('returns undefined when _cq_duid has no value', () => {
        const result = service.parseCookies('_cq_duid=');
        expect(result.duidCookie).toBeUndefined();
    });

    // --- Duplicate cookie names ---

    it('returns first match when _cq_s appears twice', () => {
        const result = service.parseCookies('_cq_s=first; _cq_s=second');
        expect(result.sCookie).toBe('first');
    });
});

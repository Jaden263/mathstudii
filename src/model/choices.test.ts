import { describe, it, expect } from 'vitest';
import { pickChoice } from './choices';

describe('input controls on definitions', () => {
  const choices = { labels: ['C20/25', 'C30/37'], values: ['[20 MPa; 1.5 MPa]', '[30 MPa; 2 MPa]'], selected: 0 };
  it('picking a choice gives the definition its value', () => {
    expect(pickChoice('[f_ck; f_ctk] := [20 MPa; 1.5 MPa]', choices, 1)).toBe('[f_ck; f_ctk] := [30 MPa; 2 MPa]');
    expect(pickChoice('g ≡ 1', { labels: ['a', 'b'], values: ['1', '"b"'], selected: 0 }, 1)).toBe('g ≡ "b"');
  });
  it('not a definition, or no such choice: nothing to do', () => {
    expect(pickChoice('x + 1', choices, 1)).toBeNull();
    expect(pickChoice('x := 1', choices, 5)).toBeNull();
  });
});

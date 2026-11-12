pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
values={}
for i=1,128 do
 values[i]={i,i+1,i+2,i+3}
end
poke(0x5220,#values)
poke(0x5221,0)
while true do
 poke(0x5221,(peek(0x5221)+1)%128)
 cls(1)
 pset(peek(0x5221),0,7)
 flip()
end
